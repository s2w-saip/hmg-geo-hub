-- Incremental migration (2026-10-28): the renewal screens' saved filters, one list per account and page.
-- The filter panel kept them in the browser (localStorage); here an account sees the same list anywhere.
-- The API writes them with hmg_saved_filter_editor, which may touch this table only. `query` is the
-- page's own filter query string, kept as the page gave it.
CREATE TABLE system.saved_filter (
    filter_id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES system.user_account,
    page text NOT NULL CHECK(page ~ '^[a-z][a-z0-9-]{0,39}$'),
    name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 40),
    query text NOT NULL CHECK(char_length(query)<=4000),
    is_default boolean NOT NULL DEFAULT false,
    position integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
-- At most one filter per account and page opens by default.
CREATE UNIQUE INDEX saved_filter_default ON system.saved_filter(user_id,page) WHERE is_default;
CREATE INDEX saved_filter_list ON system.saved_filter(user_id,page,position);
GRANT USAGE ON SCHEMA system TO hmg_saved_filter_editor;
GRANT SELECT ON system.saved_filter TO hmg_operations_reader,hmg_operations_writer;
GRANT SELECT,INSERT,UPDATE,DELETE ON system.saved_filter TO hmg_saved_filter_editor;
COMMENT ON TABLE system.saved_filter IS 'Saved filters of the renewal screens per account and page. The API binds every statement to the signed-in account.';
