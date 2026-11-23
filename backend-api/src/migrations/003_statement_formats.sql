-- Statement formats: how an uploaded statement is parsed, chosen by its file name.
-- Replaces the file-name tables that were hard-coded in statement_parser.py.

CREATE TABLE statement_format (
  statement_format_idx INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  -- Matched case-insensitively against the file name; the longest matching pattern wins.
  file_name_pattern TEXT NOT NULL,
  file_type TEXT NOT NULL CHECK (file_type IN ('csv', 'pdf')),
  -- CSV formats: 'card' or 'bank', and the column settings (JSON).
  parser TEXT CHECK (parser IN ('card', 'bank')),
  settings TEXT,
  -- PDF formats: the built-in layout that reads the statement.
  pdf_layout TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  CHECK ((file_type = 'csv' AND parser IS NOT NULL AND settings IS NOT NULL AND pdf_layout IS NULL)
      OR (file_type = 'pdf' AND parser IS NULL AND settings IS NULL AND pdf_layout IS NOT NULL))
);
CREATE UNIQUE INDEX statement_format_pattern_UQ ON statement_format (file_type, lower(trim(file_name_pattern)));

INSERT INTO statement_format (name, file_name_pattern, file_type, parser, settings) VALUES
  ('BMO Mastercard', 'bmo mastercard', 'csv', 'card',
   '{"headerRows":2,"columnCount":6,"columns":{"date":3,"description":5,"debit":4,"credit":null,"account":null,"cheque":null},"headerNames":null,"dateFormats":["%Y%m%d"]}'),
  ('CIBC Visa', 'cibc visa', 'csv', 'card',
   '{"headerRows":0,"columnCount":5,"columns":{"date":0,"description":1,"debit":2,"credit":3,"account":null,"cheque":null},"headerNames":null,"dateFormats":["%Y-%m-%d"]}'),
  ('CIBC Mastercard', 'cibc mastercard', 'csv', 'card',
   '{"headerRows":0,"columnCount":5,"columns":{"date":0,"description":1,"debit":2,"credit":3,"account":null,"cheque":null},"headerNames":null,"dateFormats":["%Y-%m-%d"]}'),
  ('CIBC Costco Mastercard', 'cibc costco mastercard', 'csv', 'card',
   '{"headerRows":0,"columnCount":5,"columns":{"date":0,"description":1,"debit":2,"credit":3,"account":null,"cheque":null},"headerNames":null,"dateFormats":["%Y-%m-%d"]}'),
  ('RBC Personal Visa', 'rbc personal visa', 'csv', 'card',
   '{"headerRows":0,"columnCount":3,"columns":{"date":0,"description":1,"debit":2,"credit":2,"account":null,"cheque":null},"headerNames":null,"dateFormats":["%Y-%m-%d"]}'),
  ('RBC Corporate Visa', 'rbc corporate visa', 'csv', 'card',
   '{"headerRows":0,"columnCount":3,"columns":{"date":0,"description":1,"debit":2,"credit":2,"account":null,"cheque":null},"headerNames":null,"dateFormats":["%Y-%m-%d"]}'),
  ('American Express', 'amex', 'csv', 'card',
   '{"headerRows":0,"columnCount":6,"columns":{"date":0,"description":3,"debit":2,"credit":2,"account":null,"cheque":null},"headerNames":null,"dateFormats":["%m/%d/%Y"]}'),
  ('Citi Mastercard', 'citi', 'csv', 'card',
   '{"headerRows":1,"columnCount":4,"columns":{"date":1,"description":2,"debit":3,"credit":3,"account":null,"cheque":null},"headerNames":null,"dateFormats":["%m/%d/%Y"]}'),
  ('Capital One Mastercard', 'capital one', 'csv', 'card',
   '{"headerRows":1,"columnCount":7,"columns":{"date":1,"description":3,"debit":5,"credit":6,"account":null,"cheque":null},"headerNames":null,"dateFormats":["%Y-%m-%d"]}'),
  ('Coast Capital (all accounts)', 'coast capital savings (all accounts)', 'csv', 'bank',
   '{"headerRows":0,"columnCount":7,"columns":{"account":0,"date":1,"description":2,"cheque":3,"debit":4,"credit":5},"headerNames":null,"dateFormats":["%d-%b-%Y","%b-%d-%Y","%Y-%m-%d"]}'),
  ('Coast Capital', 'coast', 'csv', 'bank',
   '{"headerRows":0,"columnCount":null,"columns":{"account":null,"date":null,"description":null,"cheque":null,"debit":null,"credit":null},"headerNames":{"account":"Unique ID","date":"Date","description":"Description","debit":"Amount"},"dateFormats":["%d-%b-%Y","%b-%d-%Y","%Y-%m-%d"]}'),
  ('BMO bank account', 'bmo', 'csv', 'bank',
   '{"headerRows":0,"columnCount":7,"columns":{"account":0,"date":1,"description":2,"cheque":3,"debit":4,"credit":5},"headerNames":null,"dateFormats":["%d-%b-%Y","%b-%d-%Y","%Y-%m-%d"]}'),
  ('RBC bank account', 'rbc banking', 'csv', 'bank',
   '{"headerRows":0,"columnCount":5,"columns":{"account":0,"date":1,"description":2,"cheque":null,"debit":3,"credit":4},"headerNames":null,"dateFormats":["%d-%b-%Y","%b-%d-%Y","%Y-%m-%d"]}');

INSERT INTO statement_format (name, file_name_pattern, file_type, pdf_layout) VALUES
  ('RBC bank account (PDF)', 'rbc banking', 'pdf', 'rbc-bank-statement'),
  ('RBC Personal Visa (PDF)', 'rbc personal visa', 'pdf', 'rbc-visa-statement'),
  ('RBC Corporate Visa (PDF)', 'rbc corporate visa', 'pdf', 'rbc-visa-statement');
