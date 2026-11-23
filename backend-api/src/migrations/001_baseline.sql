-- Baseline bookkeeping schema.
-- Every statement is idempotent so this migration can run against a database created by an
-- earlier version (or by the original Python scripts) without changing it.

CREATE TABLE IF NOT EXISTS account (
	account_idx INTEGER PRIMARY KEY NOT NULL,
	name TEXT NOT NULL,
	is_credit_card INTEGER NOT NULL DEFAULT (0),
	is_corporate INTEGER NOT NULL DEFAULT (0)
, is_active INTEGER DEFAULT (1) NOT NULL);
CREATE TABLE IF NOT EXISTS expense_categorization_rule (
	expense_categorization_rule_idx INTEGER PRIMARY KEY NOT NULL,
	description_filter TEXT NOT NULL,
	minimum_amount REAL NULL,
	maximum_amount REAL NULL,
	category TEXT NULL,
	exemption REAL NULL
, is_corporate INTEGER DEFAULT 0 NOT NULL);
CREATE TABLE IF NOT EXISTS account_num (
	account_idx INTEGER NOT NULL,
	account_no TEXT NOT NULL,
	CONSTRAINT account_num_account_FK FOREIGN KEY (account_idx) REFERENCES account(account_idx) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE IF NOT EXISTS deposit (
	deposit_idx INTEGER NOT NULL,
	transaction_date TEXT NOT NULL,
	description TEXT,
	amount REAL NOT NULL,
	income_amount REAL NOT NULL,
	reviewed INTEGER DEFAULT 0 NOT NULL,
	comment TEXT,
	account_idx INTEGER NOT NULL,
	CONSTRAINT DEPOSIT_PK PRIMARY KEY (deposit_idx),
	CONSTRAINT deposit_account_FK FOREIGN KEY (account_idx) REFERENCES account(account_idx) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE IF NOT EXISTS expense (
	expense_idx INTEGER NOT NULL,
	transaction_date TEXT NOT NULL,
	category TEXT,
	exemption REAL,
	description TEXT NOT NULL,
	amount REAL NOT NULL,
	account_idx INTEGER,
	comment TEXT,
	CONSTRAINT EXPENSE_PK PRIMARY KEY (expense_idx),
	CONSTRAINT expense_account_FK FOREIGN KEY (account_idx) REFERENCES account(account_idx) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE IF NOT EXISTS payment (
	payment_idx INTEGER NOT NULL,
	payee_idx INTEGER NOT NULL,
	transaction_date TEXT NOT NULL,
	amount REAL NOT NULL,
	confirmation TEXT,
	account_idx INTEGER NOT NULL,
	CONSTRAINT PAYMENT_PK PRIMARY KEY (payment_idx),
	CONSTRAINT payment_payee_FK FOREIGN KEY (payee_idx) REFERENCES payee(payee_idx) ON DELETE CASCADE ON UPDATE CASCADE,
	CONSTRAINT payment_account_FK FOREIGN KEY (account_idx) REFERENCES account(account_idx) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE IF NOT EXISTS huquq_date_range (
	start_date TEXT NOT NULL,
	end_date TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS corporate_date_range (
	start_date TEXT NOT NULL,
	end_date TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payee (
	payee_idx INTEGER NOT NULL,
	payee TEXT NOT NULL,
	account_num TEXT NOT NULL,
	is_active INTEGER DEFAULT 0 NOT NULL,
	payee_category TEXT DEFAULT '' NOT NULL,
	payment_period INTEGER DEFAULT 1 NOT NULL,
	CONSTRAINT PAYEE_PK PRIMARY KEY (payee_idx)
);
CREATE INDEX IF NOT EXISTS deposit_transaction_date_IDX ON deposit (transaction_date);
CREATE INDEX IF NOT EXISTS expense_transaction_date_IDX ON expense (transaction_date);
CREATE VIEW IF NOT EXISTS vw_payment_totals
AS
SELECT
	strftime('%Y', payment.transaction_date) AS payment_year,
	payee.payee AS recipient,
	SUM(payment.amount) AS total
FROM
	payee
JOIN payment
		USING (payee_idx)
GROUP BY
	1,
	2
ORDER BY
	1,
	2
;
CREATE VIEW IF NOT EXISTS vw_account
AS
SELECT
	account.account_idx,
	account.name,
	account_num.account_no,
	account.is_credit_card
FROM
	account
LEFT OUTER JOIN
account_num
		USING (account_idx)
;
CREATE VIEW IF NOT EXISTS vw_all_expenditures
AS
SELECT
	is_corporate,
	SUM(amount) AS all_expenditures
FROM
	payment
JOIN account USING (account_idx)
WHERE
	account.is_credit_card = 0
GROUP BY
	1
ORDER BY
	1
;
CREATE VIEW IF NOT EXISTS vw_expense_summary_for_date_range AS
select
	e.exemption_classification,
	e.category,
	floor(100.0 * sum(e.amount) + 0.5) / 100.0 as total,
	min(e.transaction_date) as start_date,
	max(e.transaction_date) as end_date
from
	vw_expense e
join huquq_date_range hdr on
	(e.transaction_date >= hdr.start_date
		and e.transaction_date < hdr.end_date)
where
	e.is_corporate = 0
	and e.transaction_type = 'Expense'
group by
	1,
	2
order by
	1,
	2
;
CREATE VIEW IF NOT EXISTS vw_expense
AS
SELECT
	'Expense' AS transaction_type,
	a.account_idx,
	a.is_corporate,
	a.name AS account,
	e.category,
	e.description,
	'Exempt' AS exemption_classification,
	CASE
		WHEN COALESCE(e.exemption,
		0) <= 1 THEN COALESCE(e.exemption,
		0) 
* e.Amount
		ELSE e.exemption
	END AS amount,
	e.transaction_date AS transaction_date
FROM
	account a
JOIN expense e
		USING (account_idx)
WHERE
	COALESCE (e.Category,
	'') NOT IN ('', 'Huquq', '3rd Party', 'Transfer')
	AND COALESCE(e.exemption,
	0) > 0
UNION ALL
SELECT
	'Expense' AS transaction_type,
	a.account_idx,
	a.is_corporate,
	a.name AS account,
	e.category,
	e.description,
	'Non-Exempt' AS exemption_classification,
	CASE
		WHEN COALESCE(e.exemption,
		0) <= 1 THEN (1 - COALESCE(e.exemption,
		0)) * e.Amount
		ELSE e.Amount - e.exemption
	END AS amount,
	e.transaction_date AS transaction_date
FROM
	account a
JOIN
	expense e
		USING (account_idx)
WHERE
	COALESCE (e.Category,
	'') NOT IN ('', 'Huquq', '3rd Party', 'Transfer')
	AND COALESCE(e.exemption,
	0) <> 1
	AND COALESCE(e.exemption,
	0) <> e.Amount
UNION ALL
SELECT
	'Expense' AS transaction_type,
	a.account_idx,
	a.is_corporate,
	a.name AS account,
	e.category,
	e.description,
	'Uncategorized' AS exemption_classification,
	e.amount,
	e.transaction_date AS transaction_date
FROM
	account a JOIN expense e USING (account_idx)
WHERE
	TRIM(COALESCE(e.Category,
	'')) = ''
UNION ALL
SELECT
	'Income' AS transaction_type,
	a.account_idx,
	a.is_corporate,
	a.name AS account,
	'Income' AS category,
	'Income' AS exemption_classification,
	d.description,
	d.income_amount AS amount,
	d.transaction_date AS transaction_date
FROM
	account a
JOIN deposit d
		USING (account_idx)
WHERE
	d.income_amount > 0
UNION ALL
SELECT
	'Income' AS transaction_type,
	a.account_idx,
	a.is_corporate,
	a.name AS account,
	'Income' AS category,
	d.description,
	'Uncategorized' AS exemption_classification,
	d.amount - d.income_amount AS amount,
	d.transaction_date AS transaction_date
FROM
	account a
JOIN deposit d
		USING (account_idx)
WHERE
	d.reviewed = 0
UNION ALL
SELECT
	'Income' AS transaction_type,
	a.account_idx,
	a.is_corporate,
	a.name AS account,
	'Income' AS category,
	d.description,
	'Reimbursement' AS exemption_classification,
	d.amount - d.income_amount AS amount,
	d.transaction_date AS transaction_date
FROM
	account a
JOIN deposit d
		USING (account_idx)
WHERE
	d.reviewed = 1
	AND d.amount > d.income_amount
;
CREATE VIEW IF NOT EXISTS vw_huquq_exemptions_for_date_range AS SELECT
	e.account_idx,
	a.is_corporate, 
	a.name AS account_name,
	e.category,
	FLOOR(SUM(e.amount) * 100.0 + 0.5) / 100.0 AS total_amount,
	FLOOR(SUM(CASE WHEN COALESCE(e.exemption, 0) <= 1 THEN COALESCE(e.exemption, 0) * e.amount ELSE e.exemption END) * 100.0 + 0.5) / 100.0 AS total_exemption,
	MIN(e.transaction_date) AS start_date,
	MAX(e.transaction_date) AS end_date
FROM
	expense e
JOIN account a
		USING (account_idx)
JOIN huquq_date_range hdr ON
	(e.transaction_date >= hdr.start_date
		and e.transaction_date < hdr.end_date)
GROUP BY
	1, 2, 3, 4
-- HAVING
-- 	total_exemption > 0
ORDER BY
	total_amount DESC
;
CREATE VIEW IF NOT EXISTS vw_huquq_payment_for_date_range as
select
	start_date,
	end_date,
	total_income,
	total_expenses,
	total_exemptions,
	uncategorized_income,
	uncategorized_expenses,
	floor(100.0 * (estimated_payment - (0.19 * uncategorized_expenses)) + 0.5) / 100. as min_payment,
	estimated_payment,
	floor(100.0 * (estimated_payment + (0.19 * uncategorized_income)) + 0.5) / 100. as max_payment
from
	(
	select
		(
		select
			MIN(start_date)
		from
			huquq_date_range) as start_date,
		(
		select
			MAX(end_date)
		from
			huquq_date_range) as end_date,
		uncategorized_expenses,
		total_expenses,
		total_exemptions,
		total_income,
		floor((total_income - total_exemptions) * 19.0 + 0.5) / 100.0 as estimated_payment,
		uncategorized_income
	from
		( (
		select
			FLOOR(coalesce(sum(e.amount), 0) * 100.0 + 0.5) / 100.0 as uncategorized_expenses
		from
			vw_uncategorized_expenses e join account a using (account_idx)
		join huquq_date_range hdr on
			(e.transaction_date >= hdr.start_date
				and e.transaction_date < hdr.end_date) where a.is_corporate = 0),
		(
		select
			FLOOR(coalesce(sum(e.total_amount), 0) * 100.0 + 0.5) / 100.0 as total_expenses
		from
			vw_huquq_exemptions_for_date_range e join account a using (account_idx) where a.is_corporate = 0 and e.category not in ('Transfer', '3rd Party', 'Huquq')),
		(
		select
			FLOOR(coalesce(sum(total_exemption), 0) * 100.0 + 0.5) / 100.0 as total_exemptions
		from
			vw_huquq_exemptions_for_date_range join account a using (account_idx) where a.is_corporate = 0),
		(
		select
			FLOOR(coalesce(sum(total_income), 0) * 100.0 + 0.5) / 100.0 as total_income
		from
			vw_huquq_income_for_date_range where is_corporate = 0),
		(
		select
			FLOOR(coalesce(sum(d.amount - d.income_amount), 0) * 100.0 + 0.5) / 100.0 as uncategorized_income
		from
			deposit d join account a using (account_idx)
		join huquq_date_range hdr on
			(d.transaction_date >= hdr.start_date
				and d.transaction_date < hdr.end_date)
		where
			a.is_corporate = 0 AND d.reviewed = 0) ))
;
CREATE VIEW IF NOT EXISTS vw_all_corporate_transactions as
select
	case
		t.transaction_type when 'Debit' then 'Expense'
		when 'Transfer' then 'Transfer'
		else 'Revenue'
	end as category,
	t.category as subcategory,
	case
		a.is_credit_card when 1 then 'Corporate Visa'
		else 'Chequing'
	end as account_type,
	(
	select
		min(an.account_no)
	from
		account_num an
	where
		an.account_idx = a.account_idx) as account_num,
	NULL as has_receipt,
	t.transaction_date,
	case
		when t.description like 'Cheque - %' then SUBSTRING(t.description, 10, 5)
		else ''
	end as cheque,
	t.description,
	case when t.comment like 'Automatic Rule%' then NULL else t.comment end as description2,
	t.amount,
	t.adjustment
from
	vw_all_transactions t
join account a
		using (account_idx)
where
	a.is_corporate
order by
	transaction_date
;
CREATE VIEW IF NOT EXISTS vw_corporate_transactions_for_date_range AS
SELECT
	vact.*
from
	vw_all_corporate_transactions vact
join corporate_date_range cdr on
	(vact.transaction_date >= cdr.start_date
		and vact.transaction_date < cdr.end_date)
order by
	transaction_date
;
CREATE VIEW IF NOT EXISTS vw_payment AS
SELECT
	pmt.payment_idx,
	pmt.payee_idx,
	p.payee as payee_name,
	p.account_num as payee_account_num,
	p.is_active as is_payee_active,
	p.payee_category,
	pmt.transaction_date,
	pmt.amount,
	pmt.confirmation,
	pmt.account_idx as payer_account_idx,
	a.name as payer_account_name,
	p.payment_period,
	a.is_credit_card as is_paid_by_credit_card,
	a.is_corporate
FROM
	payment pmt
JOIN payee p ON
	pmt.payee_idx = p.payee_idx
JOIN account a ON
	pmt.account_idx = a.account_idx
;
CREATE VIEW IF NOT EXISTS vw_uncategorized_income
AS
SELECT
	d.deposit_idx,
	d.transaction_date,
	d.description,
	d.amount,
	d.income_amount,
	d.reviewed,
	d.account_idx,
	a.is_corporate
FROM
	deposit d join account a using (account_idx)
WHERE
	(d.reviewed = 0)
;
CREATE VIEW IF NOT EXISTS vw_uncategorized_expenses AS
SELECT
	e.*,
	a.is_corporate
FROM
	expense e
join account a
		using (account_idx)
WHERE
	(COALESCE (category,
	'') = '')
;
CREATE VIEW IF NOT EXISTS vw_upcoming_payments AS SELECT * from vw_last_payment where julianday(next_payment_date) - julianday() <= CASE WHEN payment_period < 6 THEN 15 ELSE 30 END
;
CREATE VIEW IF NOT EXISTS vw_expense_categories AS SELECT a.is_corporate, e.category from expense e join account a using (account_idx) where e.category is not null group by 1, 2 order by 1, 2
;
CREATE VIEW IF NOT EXISTS vw_all_categories as
select
	a.is_corporate,
	e.category
from
	expense e
join account a
		using (account_idx)
where
	e.category is not null
group by
	1,
	2
order by
	1,
	2
;
CREATE VIEW IF NOT EXISTS vw_all_transactions AS
SELECT
	d.transaction_date,
	'Deposits' as category,
	d.description,
	d.comment,
	'Credit' as transaction_type,
	d.amount,
	a.account_idx,
	a.name as account_name,
	a.is_active as is_account_active,
	case d.reviewed when 1 then d.income_amount / d.amount else a.is_corporate end as adjustment
from
	deposit d
join account a
		using (account_idx)
union all
select
	e.transaction_date,
	e.category,
	e.description,
	e.comment,
	case e.category when 'Transfer' then 'Transfer' else 'Debit' end as transaction_type,
	-e.amount,
	a.account_idx,
	a.name as account_name,
	a.is_active as is_account_active,
	case when e.exemption > 1 then e.exemption / e.amount else
	coalesce(e.exemption, a.is_corporate) end as adjustment
from
	expense e
join account a
		using (account_idx)
;
CREATE VIEW IF NOT EXISTS vw_transaction_date_ranges AS
select
	account_idx,
	account_name,
	is_account_active,
	min(transaction_month) as first_transaction_month,
	max(transaction_month) as last_transaction_month,
	count(distinct transaction_month) as distinct_month_count,
	max(transaction_month_serial) - min(transaction_month_serial) + 1 - count(distinct transaction_month) as missing_month_count
from
	(
	select
		account_idx,
		account_name,
		is_account_active,
		STRFTIME('%Y-%m', transaction_date) as transaction_month,
		STRFTIME('%Y', transaction_date) * 12 + STRFTIME('%m', transaction_date) as transaction_month_serial
	from
		vw_all_transactions
	)
group by
	1,
	2,
	3
order by
	3 desc,
	5 desc,
	4 desc
;
CREATE VIEW IF NOT EXISTS vw_uncategorized_rules
AS
SELECT
	ecr.expense_categorization_rule_idx,
	ecr.description_filter,
	ecr.minimum_amount,
	ecr.maximum_amount,
	ecr.category,
	ecr.exemption,
	CASE
		WHEN (ecr.description_filter like '%\%%' escape '\' or ecr.description_filter like '%\_%%' escape '\') then 1
		else 0
	end as filter_has_wildcard,
	COUNT(e.expense_idx) AS match_count
FROM
	expense_categorization_rule ecr
JOIN
expense e ON
	COALESCE (ecr.minimum_amount,
	- 2000000000) <= e.amount
	AND COALESCE (ecr.maximum_amount,
	2000000000) > e.amount
JOIN account a ON
	(e.account_idx = a.account_idx
		AND ecr.is_corporate = a.is_corporate)
WHERE
	((lower(e.description) LIKE ('%' || ecr.description_filter || '%')
		and filter_has_wildcard = 0)
	OR (lower(e.description) LIKE ecr.description_filter
		and filter_has_wildcard = 1))
	AND (COALESCE(e.category,
	'') = '')
GROUP BY
	1,
	2,
	3,
	4,
	5,
	6
;
CREATE VIEW IF NOT EXISTS vw_uncategorized_descriptions
AS
SELECT
	is_corporate,
	description,
	count(*) as record_count
FROM
	expense JOIN account using (account_idx)
WHERE
	(COALESCE (category,
	'') = '')
GROUP BY
	1,
	2
ORDER BY
	1,
	3 desc,
	2
;
CREATE VIEW IF NOT EXISTS vw_huquq_income_for_date_range AS
SELECT
	a.is_corporate,
	d.description,
	FLOOR(SUM(d.income_amount) * 100.0 + 0.5) / 100.0 AS total_income,
	MIN(d.transaction_date) AS start_date,
	MAX(d.transaction_date) As end_date
FROM
	deposit d
JOIN account a
		USING (account_idx)
JOIN huquq_date_range hdr ON
	(d.transaction_date >= hdr.start_date
		and d.transaction_date < hdr.end_date)
WHERE
	(d.income_amount > 0)
	AND (d.reviewed = 1)
GROUP BY
	1,
	2
ORDER BY
	1,
	2
;
CREATE VIEW IF NOT EXISTS vw_last_payment
AS
SELECT
	pmt.payment_idx,
	p.payee,
	p.account_num,
	pmt.transaction_date AS last_payment_date,
	date(pmt.transaction_date, '+' || p.payment_period || ' month') as next_payment_date,
	pmt.amount,
	pmt.confirmation,
	account.name AS account_name,
	p.payment_period
FROM
	payee p
JOIN payment pmt
		USING (payee_idx)
JOIN account
		USING (account_idx)
WHERE
	(p.is_active <> 0)
	AND (pmt.payment_idx =
(
	SELECT
		pmt2.payment_idx
	FROM
		payment pmt2
	WHERE
		pmt.payee_idx = pmt2.payee_idx
	ORDER BY
		pmt2.transaction_date DESC,
		pmt2.payment_idx DESC
	LIMIT 1))
ORDER BY
	next_payment_date,
	p.payee
;

-- The report periods are single-row tables; give a new database a sensible default (this year).
INSERT INTO huquq_date_range (start_date, end_date)
  SELECT date('now', 'start of year'), date('now', 'start of year', '+1 year')
  WHERE NOT EXISTS (SELECT 1 FROM huquq_date_range);
INSERT INTO corporate_date_range (start_date, end_date)
  SELECT date('now', 'start of year'), date('now', 'start of year', '+1 year')
  WHERE NOT EXISTS (SELECT 1 FROM corporate_date_range);
