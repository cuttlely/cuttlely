-- Budget demo database for PostgreSQL. Everything here is made up: the company, its departments, vendors and numbers.
-- It is the second database in the two-analyst real-model check in docs/how-to/analyst.md.
-- Load it into an empty database: psql -d budget -f samples/demo/budget/budget-postgres.sql

CREATE TABLE departments (
    id integer PRIMARY KEY,
    name text NOT NULL
);
COMMENT ON TABLE departments IS 'Company departments';

CREATE TABLE budget_lines (
    id integer PRIMARY KEY,
    department_id integer REFERENCES departments (id),
    fiscal_year integer,
    category text,
    planned numeric(12, 2)
);
COMMENT ON TABLE budget_lines IS 'Planned spend per department, fiscal year and category';

CREATE TABLE expenses (
    id integer PRIMARY KEY,
    department_id integer REFERENCES departments (id),
    spent_on date,
    category text,
    amount numeric(12, 2),
    vendor text
);
COMMENT ON TABLE expenses IS 'Actual spend';

CREATE TABLE headcount_plan (
    department_id integer REFERENCES departments (id),
    fiscal_year integer,
    planned_heads integer
);

CREATE VIEW budget_vs_actual AS
SELECT d.name AS department,
       b.fiscal_year,
       sum(b.planned) AS planned,
       (SELECT coalesce(sum(e.amount), 0)
          FROM expenses e
         WHERE e.department_id = d.id
           AND extract(year FROM e.spent_on) = b.fiscal_year) AS actual
  FROM departments d
  JOIN budget_lines b ON b.department_id = d.id
 GROUP BY d.id, d.name, b.fiscal_year;
COMMENT ON VIEW budget_vs_actual IS 'Planned versus actual spend per department and fiscal year';

INSERT INTO departments (id, name) VALUES
    (1, 'Marketing'),
    (2, 'Engineering'),
    (3, 'Operations'),
    (4, 'Finance');

INSERT INTO budget_lines (id, department_id, fiscal_year, category, planned) VALUES
    (1, 1, 2026, 'Ads', 120000.00),
    (2, 1, 2026, 'Events', 40000.00),
    (3, 2, 2026, 'Cloud', 200000.00),
    (4, 2, 2026, 'Software', 60000.00),
    (5, 3, 2026, 'Logistics', 90000.00),
    (6, 3, 2026, 'Facilities', 70000.00),
    (7, 4, 2026, 'Audit', 30000.00),
    (8, 4, 2026, 'Software', 15000.00);

INSERT INTO expenses (id, department_id, spent_on, category, amount, vendor) VALUES
    (1, 1, '2026-01-15', 'Ads', 45000.00, 'AdNet'),
    (2, 1, '2026-03-10', 'Ads', 52000.00, 'AdNet'),
    (3, 1, '2026-04-02', 'Events', 18000.00, 'ExpoCo'),
    (4, 2, '2026-02-01', 'Cloud', 110000.00, 'SkyCloud'),
    (5, 2, '2026-05-01', 'Cloud', 105000.00, 'SkyCloud'),
    (6, 2, '2026-03-20', 'Software', 22000.00, 'DevTools Inc'),
    (7, 3, '2026-02-11', 'Logistics', 30000.00, 'FastShip'),
    (8, 3, '2026-06-11', 'Facilities', 25000.00, 'BuildRight'),
    (9, 4, '2026-04-30', 'Audit', 31000.00, 'Ledger LLP'),
    (10, 4, '2026-01-05', 'Software', 4000.00, 'DevTools Inc');

INSERT INTO headcount_plan (department_id, fiscal_year, planned_heads) VALUES
    (1, 2026, 8),
    (2, 2026, 25),
    (3, 2026, 12),
    (4, 2026, 5);
