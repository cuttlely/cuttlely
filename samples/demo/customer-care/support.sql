-- The support desk database for the customer care demo. Larkfield Home is a made-up online home goods store, and every
-- name, address and order here is made up. Only the customer specialist reads this file.
CREATE TABLE customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    tier TEXT NOT NULL CHECK (tier IN ('Standard', 'Plus', 'Premier')),
    member_since TEXT NOT NULL,
    city TEXT NOT NULL,
    state TEXT NOT NULL
);

CREATE TABLE orders (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id),
    placed_on TEXT NOT NULL,
    promised_by TEXT NOT NULL,
    delivered_on TEXT,
    status TEXT NOT NULL,
    total REAL NOT NULL
);

CREATE TABLE contacts (
    id INTEGER PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id),
    contacted_on TEXT NOT NULL,
    channel TEXT NOT NULL,
    order_id TEXT,
    reason TEXT NOT NULL,
    summary TEXT NOT NULL,
    credit REAL NOT NULL DEFAULT 0,
    credit_type TEXT
);

INSERT INTO customers VALUES
    ('C-1001', 'Maya Okafor', 'maya.okafor@example.com', 'Plus', '2023-03-18', 'Portland', 'OR'),
    ('C-1002', 'Daniel Reyes', 'd.reyes@example.net', 'Standard', '2025-11-02', 'Denver', 'CO'),
    ('C-1003', 'Priya Natarajan', 'priya.n@example.org', 'Premier', '2021-06-09', 'Austin', 'TX'),
    ('C-1004', 'Tom Lindqvist', 'tom.lindqvist@example.com', 'Standard', '2024-08-21', 'Columbus', 'OH'),
    ('C-1005', 'Grace Whitfield', 'gwhitfield@example.net', 'Plus', '2022-01-30', 'Atlanta', 'GA'),
    ('C-1006', 'Omar Haddad', 'omar.haddad@example.org', 'Premier', '2020-10-12', 'Chicago', 'IL'),
    ('C-1007', 'Lena Fischer', 'lena.f@example.com', 'Standard', '2026-02-14', 'Reno', 'NV'),
    ('C-1008', 'Sam Park', 'sam.park@example.net', 'Plus', '2024-04-05', 'Seattle', 'WA');

INSERT INTO orders VALUES
    ('LH-14120', 'C-1001', '2025-11-20', '2025-11-26', '2025-11-25', 'delivered', 184.00),
    ('LH-15377', 'C-1001', '2026-01-08', '2026-01-14', '2026-01-13', 'delivered', 96.50),
    ('LH-16902', 'C-1001', '2026-03-22', '2026-03-27', '2026-03-26', 'delivered', 412.90),
    ('LH-17741', 'C-1001', '2026-05-30', '2026-06-04', '2026-06-03', 'delivered', 58.00),
    ('LH-18802', 'C-1001', '2026-08-07', '2026-08-12', '2026-08-15', 'delivered', 139.00),
    ('LH-20417', 'C-1001', '2026-09-28', '2026-10-02', NULL, 'open', 288.95),
    ('LH-19544', 'C-1002', '2026-08-29', '2026-09-04', '2026-09-03', 'delivered', 42.00),
    ('LH-20398', 'C-1002', '2026-09-28', '2026-10-03', NULL, 'open', 138.95),
    ('LH-20409', 'C-1003', '2026-09-28', '2026-10-01', NULL, 'open', 349.00),
    ('LH-20411', 'C-1004', '2026-09-28', '2026-10-01', NULL, 'open', 64.95),
    ('LH-20420', 'C-1005', '2026-09-28', '2026-10-02', NULL, 'open', 219.00),
    ('LH-20423', 'C-1007', '2026-09-28', '2026-10-02', NULL, 'open', 87.95),
    ('LH-20431', 'C-1006', '2026-09-30', '2026-10-05', '2026-10-05', 'delivered', 129.00),
    ('LH-20455', 'C-1008', '2026-10-01', '2026-10-07', NULL, 'open', 74.00),
    ('LH-18010', 'C-1003', '2026-07-11', '2026-07-15', '2026-07-15', 'delivered', 1210.00),
    ('LH-18877', 'C-1006', '2026-08-10', '2026-08-14', '2026-08-14', 'delivered', 365.40);

INSERT INTO contacts (customer_id, contacted_on, channel, order_id, reason, summary, credit, credit_type) VALUES
    ('C-1001', '2026-01-16', 'chat', 'LH-15377', 'question', 'Asked how to descale the kettle from order LH-15377. Sent the care guide.', 0, NULL),
    ('C-1001', '2026-08-15', 'email', 'LH-18802', 'late delivery', 'Order LH-18802 arrived 3 days after the promised date. Parcelway reported a weather delay at its Boise hub after pickup.', 10.00, 'goodwill'),
    ('C-1002', '2026-09-05', 'chat', 'LH-19544', 'question', 'Asked whether the linen napkins can be tumble dried. Answered from the product page.', 0, NULL),
    ('C-1003', '2026-07-16', 'phone', 'LH-18010', 'praise', 'Called to say the dining chairs arrived early and well packed.', 0, NULL),
    ('C-1005', '2026-04-03', 'email', NULL, 'account', 'Changed the default delivery address.', 0, NULL),
    ('C-1006', '2026-08-20', 'chat', 'LH-18877', 'return', 'Returned one of two lamps. Refunded the lamp.', 0, NULL),
    ('C-1008', '2026-06-11', 'email', NULL, 'question', 'Asked when Plus members get early access to the autumn sale.', 0, NULL);
