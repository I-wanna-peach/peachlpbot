-- peachlpbot initial schema. Every statement is idempotent: migrations replay on
-- every `bun run migrate` so an interrupted run can be re-applied safely.
--
-- Addresses and block hashes are stored as `bytea` (lowercase), large integers
-- as `numeric(78,0)`. Invariants that must never be violated by a hand repair are
-- expressed as CHECK constraints rather than left to application code.
--
-- One deployment serves several chains; `chain_id` is part of every primary key.

-- Cheap per-chain ownership index built ONLY from ERC-721 Transfer logs (no RPC
-- reads). For Uniswap v4 it answers "which token ids does this address own"
-- because the v4 PositionManager is not Enumerable. For v3 venues it only holds
-- watched-side transfers; the authoritative discovery is ERC721Enumerable at head.
CREATE TABLE IF NOT EXISTS position_owners (
    chain_id           bigint        NOT NULL,
    dex                text          NOT NULL CHECK (dex IN ('UNISWAP_V3','PANCAKE_V3','UNISWAP_V4')),
    token_id           numeric(78,0) NOT NULL,
    owner              bytea         NOT NULL,
    minted_block       bigint        NOT NULL,
    updated_block      bigint        NOT NULL,
    updated_block_hash bytea         NOT NULL,
    PRIMARY KEY (chain_id, dex, token_id)
);
CREATE INDEX IF NOT EXISTS position_owners_by_owner ON position_owners (chain_id, owner);

-- Per-chain materialized LP positions: one row per (chain, dex, tokenId).
-- `dex` disambiguates venues whose token ids overlap (Uniswap and PancakeSwap
-- both mint ids starting at 1 on BSC).
CREATE TABLE IF NOT EXISTS positions (
    chain_id           bigint        NOT NULL,
    dex                text          NOT NULL CHECK (dex IN ('UNISWAP_V3','PANCAKE_V3','UNISWAP_V4')),
    token_id           numeric(78,0) NOT NULL,
    owner              bytea         NOT NULL,
    pool_ref           text          NOT NULL,
    currency0          bytea         NOT NULL,
    currency1          bytea         NOT NULL,
    fee                integer       NOT NULL,
    tick_spacing       integer       NOT NULL,
    hooks              bytea         NOT NULL,
    tick_lower         integer       NOT NULL,
    tick_upper         integer       NOT NULL,
    liquidity          numeric(78,0) NOT NULL,
    status             text          NOT NULL CHECK (status IN ('ACTIVE','CLOSED')),
    range_state        text          NOT NULL DEFAULT 'UNKNOWN'
                         CHECK (range_state IN ('UNKNOWN','IN_RANGE','OUT_OF_RANGE')),
    out_streak         smallint      NOT NULL DEFAULT 0,
    in_streak          smallint      NOT NULL DEFAULT 0,
    state_version      integer       NOT NULL DEFAULT 0,
    last_eval_block    bigint,
    opened_block       bigint        NOT NULL,
    updated_block      bigint        NOT NULL,
    updated_block_hash bytea         NOT NULL,
    created_at         timestamptz   NOT NULL DEFAULT now(),
    updated_at         timestamptz   NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, dex, token_id),
    CHECK (tick_spacing > 0),
    CHECK (tick_lower < tick_upper),
    CHECK (tick_lower % tick_spacing = 0 AND tick_upper % tick_spacing = 0),
    CHECK (liquidity >= 0),
    CHECK ((status = 'CLOSED') = (liquidity = 0)),
    CHECK (status = 'ACTIVE' OR range_state = 'UNKNOWN')
);
CREATE INDEX IF NOT EXISTS positions_by_owner ON positions (chain_id, owner);
CREATE INDEX IF NOT EXISTS positions_active_pools ON positions (chain_id, dex, pool_ref)
    WHERE status = 'ACTIVE';

-- Pool identity + latest tick cache. The monitor groups positions by pool and
-- reads each pool's tick once per round, then writes it back here.
CREATE TABLE IF NOT EXISTS pools (
    chain_id     bigint  NOT NULL,
    dex          text    NOT NULL CHECK (dex IN ('UNISWAP_V3','PANCAKE_V3','UNISWAP_V4')),
    pool_ref     text    NOT NULL,
    currency0    bytea   NOT NULL,
    currency1    bytea   NOT NULL,
    fee          integer NOT NULL,
    tick_spacing integer NOT NULL,
    hooks        bytea   NOT NULL,
    current_tick integer,
    sqrt_price_x96 numeric(78,0),
    liquidity    numeric(78,0),
    initialized  boolean NOT NULL DEFAULT true,
    last_checked_block bigint,
    last_checked_block_hash bytea,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, dex, pool_ref)
);

-- Watch-only subscriptions. An address here is only "an address this chat is
-- interested in"; the same subscription covers every enabled chain, so a single
-- /watch surfaces BSC and Arc positions together.
CREATE TABLE IF NOT EXISTS subscriptions (
    id               bigserial PRIMARY KEY,
    telegram_chat_id bigint    NOT NULL,
    watched_address  bytea     NOT NULL,
    nickname         text,
    status           text      NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CHECK (nickname IS NULL OR char_length(nickname) BETWEEN 1 AND 32)
);
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_active_unique
    ON subscriptions (telegram_chat_id, watched_address) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS subscriptions_by_address
    ON subscriptions (watched_address) WHERE status = 'ACTIVE';

-- Telegram update idempotency (long-poll replays and webhook retries).
CREATE TABLE IF NOT EXISTS telegram_updates (
    update_id        bigint PRIMARY KEY,
    telegram_chat_id bigint NOT NULL,
    kind             text   NOT NULL,
    received_at      timestamptz NOT NULL DEFAULT now()
);

-- Deterministic, idempotent alerts. Range incidents carry a token id; every
-- incident carries an owner so fan-out is a plain address join.
CREATE TABLE IF NOT EXISTS incidents (
    id              bigserial PRIMARY KEY,
    chain_id        bigint NOT NULL,
    idempotency_key text   NOT NULL UNIQUE,
    type            text   NOT NULL CHECK (type IN
                      ('LP_OUT_OF_RANGE','LP_BACK_IN_RANGE','LP_POSITION_CHANGED')),
    dex             text   NOT NULL,
    pool_ref        text   NOT NULL,
    token_id        numeric(78,0),
    owner           bytea,
    from_state      text,
    to_state        text,
    state_version   integer NOT NULL,
    block_number    bigint NOT NULL,
    block_hash      bytea  NOT NULL,
    payload         jsonb  NOT NULL,
    corrected_by    bigint,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS incidents_by_pool ON incidents (chain_id, dex, pool_ref);

-- Transactional outbox: an incident and its fan-out are committed together.
CREATE TABLE IF NOT EXISTS deliveries (
    id               bigserial PRIMARY KEY,
    incident_id      bigint NOT NULL REFERENCES incidents(id),
    subscription_id  bigint NOT NULL REFERENCES subscriptions(id),
    telegram_chat_id bigint NOT NULL,
    status           text   NOT NULL DEFAULT 'QUEUED'
                       CHECK (status IN ('QUEUED','SENDING','DELIVERED','RETRY_WAIT','FAILED_FINAL')),
    attempts         integer NOT NULL DEFAULT 0,
    next_retry_at    timestamptz,
    telegram_message_id bigint,
    error_class      text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (incident_id, subscription_id)
);
CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries (next_retry_at)
    WHERE status IN ('QUEUED','RETRY_WAIT');

-- Append-only decoded position events. Retaining them lets a reorg rollback
-- rebuild an affected position from its own history instead of losing a row whose
-- mint predates the reorg window.
CREATE TABLE IF NOT EXISTS position_events (
    chain_id    bigint NOT NULL,
    dex         text   NOT NULL CHECK (dex IN ('UNISWAP_V3','PANCAKE_V3','UNISWAP_V4')),
    kind        text   NOT NULL,
    block_number bigint NOT NULL,
    block_hash  bytea  NOT NULL,
    transaction_hash bytea NOT NULL,
    log_index   integer NOT NULL,
    token_id    numeric(78,0),
    pool_ref    text,
    owner       bytea,
    tick_lower  integer,
    tick_upper  integer,
    liquidity_delta numeric(78,0),
    PRIMARY KEY (chain_id, dex, block_number, log_index)
);
CREATE INDEX IF NOT EXISTS position_events_by_token ON position_events (chain_id, dex, token_id, block_number, log_index);

-- One cursor per log stream, carrying the last canonical block hash so a reorg
-- is detected by a hash mismatch rather than a block-number gap.
CREATE TABLE IF NOT EXISTS indexer_cursors (
    chain_id   bigint NOT NULL,
    stream     text   NOT NULL,
    last_block bigint NOT NULL,
    last_block_hash bytea NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, stream)
);

-- Token metadata cache used to turn ticks into human-readable prices.
CREATE TABLE IF NOT EXISTS tokens (
    chain_id   bigint   NOT NULL,
    address    bytea    NOT NULL,
    symbol     text     NOT NULL,
    decimals   smallint NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, address),
    CHECK (decimals BETWEEN 0 AND 255)
);

-- Ops/analytics view: chain <-> pool <-> position -> subscribed chat.
CREATE OR REPLACE VIEW v_pool_position_subscriber AS
SELECT
    p.chain_id,
    p.dex,
    p.pool_ref,
    pl.currency0 AS pool_currency0,
    pl.currency1 AS pool_currency1,
    pl.fee        AS pool_fee,
    pl.tick_spacing AS pool_tick_spacing,
    pl.current_tick AS pool_current_tick,
    p.token_id,
    p.owner       AS position_owner,
    p.tick_lower,
    p.tick_upper,
    p.liquidity,
    p.status      AS position_status,
    p.range_state,
    s.id          AS subscription_id,
    s.telegram_chat_id
FROM positions p
JOIN subscriptions s
    ON s.watched_address = p.owner
   AND s.status = 'ACTIVE'
LEFT JOIN pools pl
    ON pl.chain_id = p.chain_id
   AND pl.dex = p.dex
   AND pl.pool_ref = p.pool_ref;
