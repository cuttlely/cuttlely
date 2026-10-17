-- Bakery demo database for PostgreSQL. Everything here is made up: the bakery, its shops, accounts, staff and numbers.
-- It shows the PostgreSQL MCP table picker: tables, views and materialized views with comments.
-- Load it into an empty database: psql -d bakery -f samples/demo/bakery/bakery-postgres.sql

CREATE TABLE stores (
    id integer PRIMARY KEY,
    name text NOT NULL,
    address text NOT NULL,
    opened_on date NOT NULL
);
COMMENT ON TABLE stores IS 'Bakery shops';
COMMENT ON COLUMN stores.name IS 'Shop name shown on receipts';

CREATE TABLE products (
    id integer PRIMARY KEY,
    name text NOT NULL,
    category text NOT NULL,
    price numeric(8, 2) NOT NULL,
    active boolean NOT NULL DEFAULT true
);
COMMENT ON TABLE products IS 'Everything the bakery sells';
COMMENT ON COLUMN products.category IS 'Bread, Pastry, Cookie or Dessert';
COMMENT ON COLUMN products.price IS 'Shop price in dollars';

CREATE TABLE weekly_sales (
    week_start date NOT NULL,
    store_id integer NOT NULL REFERENCES stores (id),
    product_id integer NOT NULL REFERENCES products (id),
    units integer NOT NULL,
    revenue numeric(10, 2) NOT NULL,
    PRIMARY KEY (week_start, store_id, product_id)
);
COMMENT ON TABLE weekly_sales IS 'Shop sales per product and week';
COMMENT ON COLUMN weekly_sales.week_start IS 'Monday of the sales week';

CREATE TABLE wholesale_accounts (
    id integer PRIMARY KEY,
    account_code text NOT NULL UNIQUE,
    name text NOT NULL,
    city text NOT NULL,
    credit_limit numeric(10, 2) NOT NULL
);
COMMENT ON TABLE wholesale_accounts IS 'Cafes and grocers that buy wholesale';
COMMENT ON COLUMN wholesale_accounts.account_code IS 'Code printed on invoices, such as WA-1004';

CREATE TABLE orders (
    id integer PRIMARY KEY,
    account_id integer NOT NULL REFERENCES wholesale_accounts (id),
    store_id integer NOT NULL REFERENCES stores (id),
    ordered_on date NOT NULL,
    delivery_on date NOT NULL,
    status text NOT NULL
);
COMMENT ON TABLE orders IS 'Wholesale orders';
COMMENT ON COLUMN orders.status IS 'open, delivered or cancelled';
COMMENT ON COLUMN orders.store_id IS 'Shop that bakes the order';

CREATE TABLE order_lines (
    order_id integer NOT NULL REFERENCES orders (id),
    product_id integer NOT NULL REFERENCES products (id),
    quantity integer NOT NULL,
    unit_price numeric(8, 2) NOT NULL,
    PRIMARY KEY (order_id, product_id)
);
COMMENT ON TABLE order_lines IS 'Products on each wholesale order';
COMMENT ON COLUMN order_lines.unit_price IS 'Wholesale price per unit';

CREATE TABLE invoices (
    id integer PRIMARY KEY,
    order_id integer NOT NULL REFERENCES orders (id),
    account_id integer NOT NULL REFERENCES wholesale_accounts (id),
    issued_on date NOT NULL,
    due_on date NOT NULL,
    amount numeric(10, 2) NOT NULL,
    paid_on date
);
COMMENT ON TABLE invoices IS 'One invoice per delivered order';
COMMENT ON COLUMN invoices.paid_on IS 'Empty while the invoice is unpaid';

CREATE TABLE suppliers (
    id integer PRIMARY KEY,
    name text NOT NULL,
    city text NOT NULL,
    lead_time_days integer NOT NULL
);
COMMENT ON TABLE suppliers IS 'Ingredient suppliers';

CREATE TABLE ingredients (
    id integer PRIMARY KEY,
    name text NOT NULL,
    unit text NOT NULL,
    supplier_id integer NOT NULL REFERENCES suppliers (id),
    cost_per_unit numeric(8, 4) NOT NULL
);
COMMENT ON TABLE ingredients IS 'Raw ingredients and what they cost';
COMMENT ON COLUMN ingredients.unit IS 'kg, l or each';

CREATE TABLE recipe_lines (
    product_id integer NOT NULL REFERENCES products (id),
    ingredient_id integer NOT NULL REFERENCES ingredients (id),
    quantity numeric(8, 4) NOT NULL,
    PRIMARY KEY (product_id, ingredient_id)
);
COMMENT ON TABLE recipe_lines IS 'Ingredient quantity per unit of product';

CREATE TABLE staff (
    id integer PRIMARY KEY,
    store_id integer NOT NULL REFERENCES stores (id),
    display_name text NOT NULL,
    role text NOT NULL,
    hourly_rate numeric(6, 2) NOT NULL
);
COMMENT ON TABLE staff IS 'Shop staff';
COMMENT ON COLUMN staff.role IS 'baker, counter or manager';

CREATE TABLE shifts (
    id integer PRIMARY KEY,
    staff_id integer NOT NULL REFERENCES staff (id),
    store_id integer NOT NULL REFERENCES stores (id),
    starts_at timestamp NOT NULL,
    ends_at timestamp NOT NULL
);
COMMENT ON TABLE shifts IS 'Worked shifts';

CREATE TABLE waste_log (
    id integer PRIMARY KEY,
    store_id integer NOT NULL REFERENCES stores (id),
    product_id integer NOT NULL REFERENCES products (id),
    logged_on date NOT NULL,
    units integer NOT NULL,
    reason text NOT NULL
);
COMMENT ON TABLE waste_log IS 'Unsold or damaged units thrown away';
COMMENT ON COLUMN waste_log.reason IS 'unsold, burnt or dropped';

CREATE TABLE payroll_notes (
    id integer PRIMARY KEY,
    staff_id integer NOT NULL REFERENCES staff (id),
    written_on date NOT NULL,
    note text NOT NULL
);
COMMENT ON TABLE payroll_notes IS 'Manager notes about pay. Not for the analyst.';

INSERT INTO stores VALUES
    (1, 'Riverside', 'Harbor Street 12', '2019-03-01'),
    (2, 'Old Town', 'Mill Lane 3', '2021-09-15');

INSERT INTO products VALUES
    (1, 'Sourdough Loaf', 'Bread', 7.50, true),
    (2, 'Croissant', 'Pastry', 3.75, true),
    (3, 'Cinnamon Roll', 'Pastry', 4.25, true),
    (4, 'Baguette', 'Bread', 4.00, true),
    (5, 'Blueberry Muffin', 'Pastry', 3.50, true),
    (6, 'Chocolate Chip Cookie', 'Cookie', 2.50, true),
    (7, 'Seeded Rye', 'Bread', 6.75, true),
    (8, 'Lemon Tart', 'Dessert', 5.25, false);

INSERT INTO weekly_sales
SELECT week::date, s.id, p.id, u.units, round(u.units * p.price, 2)
FROM generate_series('2026-01-05'::date, '2026-06-29'::date, interval '7 days') AS week
CROSS JOIN stores s CROSS JOIN products p
CROSS JOIN LATERAL (SELECT 40 + ((extract(doy FROM week)::int * 7 + s.id * 31 + p.id * 13) % 180) AS units) u;

INSERT INTO wholesale_accounts VALUES
    (1, 'WA-1001', 'Corner Cup Cafe', 'Riverside', 1500),
    (2, 'WA-1002', 'Green Basket Grocers', 'Old Town', 4000),
    (3, 'WA-1003', 'Morning Tram Kiosk', 'Riverside', 800),
    (4, 'WA-1004', 'Hilltop Deli', 'Old Town', 2500),
    (5, 'WA-1005', 'Lantern Bookshop Cafe', 'Riverside', 1000);

INSERT INTO orders
SELECT n, 1 + n % 5, 1 + n % 2, '2026-03-01'::date + n, '2026-03-02'::date + n,
       CASE WHEN n % 9 = 0 THEN 'cancelled' WHEN n > 54 THEN 'open' ELSE 'delivered' END
FROM generate_series(1, 60) AS n;

INSERT INTO order_lines
SELECT o.id, p.id, 6 + (o.id * p.id) % 30, round(p.price * 0.7, 2)
FROM orders o JOIN products p ON (o.id + p.id) % 3 = 0;

INSERT INTO invoices
SELECT o.id, o.id, o.account_id, o.delivery_on, o.delivery_on + 30,
       (SELECT sum(quantity * unit_price) FROM order_lines l WHERE l.order_id = o.id),
       CASE WHEN o.id % 4 = 0 THEN NULL ELSE o.delivery_on + 12 END
FROM orders o WHERE o.status = 'delivered';

INSERT INTO suppliers VALUES
    (1, 'North Mill Flour', 'Ashford', 3),
    (2, 'Meadow Dairy', 'Brookvale', 1),
    (3, 'Orchard Fruit Co', 'Pinecrest', 2);

INSERT INTO ingredients VALUES
    (1, 'Bread flour', 'kg', 1, 0.9200),
    (2, 'Butter', 'kg', 2, 7.4000),
    (3, 'Sugar', 'kg', 1, 1.1000),
    (4, 'Eggs', 'each', 2, 0.2800),
    (5, 'Blueberries', 'kg', 3, 9.5000),
    (6, 'Lemons', 'each', 3, 0.4500),
    (7, 'Rye flour', 'kg', 1, 1.3000),
    (8, 'Chocolate chips', 'kg', 1, 11.0000);

INSERT INTO recipe_lines VALUES
    (1, 1, 0.5000), (2, 1, 0.0600), (2, 2, 0.0350), (3, 1, 0.0700), (3, 3, 0.0200), (3, 2, 0.0200),
    (4, 1, 0.2500), (5, 1, 0.0500), (5, 5, 0.0300), (5, 4, 0.5000), (6, 1, 0.0300), (6, 8, 0.0150),
    (7, 7, 0.4000), (7, 1, 0.1000), (8, 6, 0.5000), (8, 2, 0.0300), (8, 3, 0.0400);

INSERT INTO staff VALUES
    (1, 1, 'Baker A', 'baker', 24.00), (2, 1, 'Counter B', 'counter', 19.50), (3, 1, 'Manager C', 'manager', 31.00),
    (4, 2, 'Baker D', 'baker', 23.50), (5, 2, 'Counter E', 'counter', 19.00), (6, 2, 'Manager F', 'manager', 30.00);

INSERT INTO shifts
SELECT n, 1 + n % 6, CASE WHEN 1 + n % 6 <= 3 THEN 1 ELSE 2 END,
       '2026-06-01 05:00'::timestamp + (n / 6) * interval '1 day',
       '2026-06-01 13:00'::timestamp + (n / 6) * interval '1 day'
FROM generate_series(1, 120) AS n;

INSERT INTO waste_log
SELECT n, 1 + n % 2, 1 + n % 8, '2026-06-01'::date + n % 30, 1 + n % 7,
       (ARRAY['unsold', 'burnt', 'dropped'])[1 + n % 3]
FROM generate_series(1, 90) AS n;

INSERT INTO payroll_notes VALUES (1, 3, '2026-06-30', 'Made-up note for the demo.');

CREATE VIEW weekly_store_revenue AS
SELECT w.week_start, s.name AS store, sum(w.units) AS units, sum(w.revenue) AS revenue
FROM weekly_sales w JOIN stores s ON s.id = w.store_id
GROUP BY w.week_start, s.name;
COMMENT ON VIEW weekly_store_revenue IS 'Shop revenue per week. Use for shop sales questions.';

CREATE VIEW account_balances AS
SELECT a.id AS account_id, a.account_code, a.name, a.credit_limit,
       count(i.id) FILTER (WHERE i.paid_on IS NULL) AS unpaid_invoices,
       coalesce(sum(i.amount) FILTER (WHERE i.paid_on IS NULL), 0) AS balance_due
FROM wholesale_accounts a LEFT JOIN invoices i ON i.account_id = a.id
GROUP BY a.id;
COMMENT ON VIEW account_balances IS 'What each wholesale account owes. Look up account_id by account_code first.';

CREATE VIEW open_orders AS
SELECT o.id AS order_id, a.account_code, o.delivery_on, s.name AS store,
       sum(l.quantity) AS units, sum(l.quantity * l.unit_price) AS value
FROM orders o
JOIN wholesale_accounts a ON a.id = o.account_id
JOIN stores s ON s.id = o.store_id
JOIN order_lines l ON l.order_id = o.id
WHERE o.status = 'open'
GROUP BY o.id, a.account_code, o.delivery_on, s.name;
COMMENT ON VIEW open_orders IS 'Wholesale orders not yet delivered';

CREATE VIEW product_margins AS
SELECT p.id AS product_id, p.name, p.price,
       round(sum(r.quantity * i.cost_per_unit), 2) AS ingredient_cost,
       round(p.price - sum(r.quantity * i.cost_per_unit), 2) AS margin
FROM products p JOIN recipe_lines r ON r.product_id = p.id JOIN ingredients i ON i.id = r.ingredient_id
GROUP BY p.id;
COMMENT ON VIEW product_margins IS 'Shop price minus ingredient cost per product';

CREATE MATERIALIZED VIEW monthly_sales AS
SELECT date_trunc('month', w.week_start)::date AS month, s.name AS store, p.name AS product, p.category,
       sum(w.units) AS units, sum(w.revenue) AS revenue
FROM weekly_sales w JOIN stores s ON s.id = w.store_id JOIN products p ON p.id = w.product_id
GROUP BY 1, 2, 3, 4;
COMMENT ON MATERIALIZED VIEW monthly_sales IS 'Shop sales per month, shop and product. Refreshed nightly.';

CREATE MATERIALIZED VIEW top_products AS
SELECT p.name AS product, sum(w.units) AS units, rank() OVER (ORDER BY sum(w.units) DESC) AS rank
FROM weekly_sales w JOIN products p ON p.id = w.product_id
GROUP BY p.name;
COMMENT ON MATERIALIZED VIEW top_products IS 'Products ranked by units sold, not revenue, over all shops and weeks. For revenue use monthly_sales.';
