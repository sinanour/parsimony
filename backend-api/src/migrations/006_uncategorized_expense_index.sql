-- Rule runs, dry runs, previews and per-rule match counts only ever look at uncategorized expenses
-- (`category IS NULL`). Without an index each rule scanned the whole expense table, so a dry run over a few
-- hundred rules took seconds and blocked the (single-threaded) server. This partial index holds only the
-- uncategorized rows, so each rule now visits just those. Purely additive.

CREATE INDEX IF NOT EXISTS expense_uncategorized_IDX ON expense (account_idx) WHERE category IS NULL;
