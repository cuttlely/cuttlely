-- The fulfillment database for the customer care demo: warehouse scans, carrier tracking, stock and transit times for
-- Larkfield Home, a made-up online home goods store. Everything here is made up. Only the operations specialist reads
-- this file.
CREATE TABLE warehouses (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    city TEXT NOT NULL,
    state TEXT NOT NULL
);

CREATE TABLE order_lines (
    order_id TEXT NOT NULL,
    sku TEXT NOT NULL,
    item TEXT NOT NULL,
    qty INTEGER NOT NULL,
    unit_price REAL NOT NULL,
    shipping_paid REAL NOT NULL,
    warehouse TEXT NOT NULL REFERENCES warehouses(code),
    service TEXT NOT NULL,
    promised_by TEXT NOT NULL,
    ship_to_city TEXT NOT NULL,
    ship_to_state TEXT NOT NULL
);

CREATE TABLE warehouse_events (
    order_id TEXT NOT NULL,
    at TEXT NOT NULL,
    warehouse TEXT NOT NULL,
    station TEXT,
    wave TEXT,
    event TEXT NOT NULL,
    detail TEXT
);

CREATE TABLE shipments (
    order_id TEXT PRIMARY KEY,
    carrier TEXT NOT NULL,
    tracking TEXT NOT NULL,
    service TEXT NOT NULL,
    label_created_at TEXT NOT NULL,
    handed_to_carrier_at TEXT
);

CREATE TABLE carrier_events (
    tracking TEXT NOT NULL,
    at TEXT NOT NULL,
    location TEXT NOT NULL,
    status TEXT NOT NULL
);

CREATE TABLE inventory (
    sku TEXT NOT NULL,
    warehouse TEXT NOT NULL REFERENCES warehouses(code),
    on_hand INTEGER NOT NULL,
    PRIMARY KEY (sku, warehouse)
);

-- Business days in transit from a warehouse to a state, by service.
CREATE TABLE transit (
    warehouse TEXT NOT NULL REFERENCES warehouses(code),
    state TEXT NOT NULL,
    service TEXT NOT NULL,
    business_days INTEGER NOT NULL
);

INSERT INTO warehouses VALUES
    ('CMH', 'Columbus fulfillment center', 'Columbus', 'OH'),
    ('RNO', 'Reno fulfillment center', 'Reno', 'NV'),
    ('ATL', 'Atlanta fulfillment center', 'Atlanta', 'GA');

INSERT INTO order_lines VALUES
    ('LH-20417', 'KIT-ESP-DUO', 'Brava Duo espresso machine', 1, 279.00, 9.95, 'CMH', 'Ground', '2026-10-02', 'Portland', 'OR'),
    ('LH-20398', 'BED-LIN-QN', 'Washed linen duvet set, queen', 1, 129.00, 9.95, 'RNO', 'Ground', '2026-10-03', 'Denver', 'CO'),
    ('LH-20409', 'DIN-OAK-BEN', 'Oak dining bench', 1, 349.00, 0, 'CMH', 'Ground', '2026-10-01', 'Austin', 'TX'),
    ('LH-20411', 'KIT-KNF-3', 'Three-piece kitchen knife set', 1, 55.00, 9.95, 'CMH', 'Ground', '2026-10-01', 'Columbus', 'OH'),
    ('LH-20420', 'LMP-ARC-BRS', 'Brass arc floor lamp', 1, 219.00, 0, 'CMH', 'Ground', '2026-10-02', 'Atlanta', 'GA'),
    ('LH-20423', 'BTH-TWL-6', 'Six-piece cotton towel set', 1, 78.00, 9.95, 'CMH', 'Ground', '2026-10-02', 'Reno', 'NV'),
    ('LH-20431', 'LMP-TBL-CER', 'Ceramic table lamp', 1, 129.00, 0, 'ATL', 'Ground', '2026-10-05', 'Chicago', 'IL'),
    ('LH-20455', 'KIT-PAN-12', 'Carbon steel pan, 12 inch', 1, 64.00, 10.00, 'RNO', 'Ground', '2026-10-07', 'Seattle', 'WA');

-- Packing wave W-0929-B at station P7 in Columbus: every parcel in it failed the outbound scale check.
INSERT INTO warehouse_events VALUES
    ('LH-20417', '2026-09-29 10:42', 'CMH', 'C-14', 'W-0929-B', 'picked', 'Bin C-14-03'),
    ('LH-20417', '2026-09-29 11:05', 'CMH', 'P7', 'W-0929-B', 'packed', 'Box size L2'),
    ('LH-20417', '2026-09-29 11:06', 'CMH', 'P7', 'W-0929-B', 'label created', 'Parcelway Ground PW7731940562'),
    ('LH-20417', '2026-09-29 16:40', 'CMH', 'SCALE-2', 'W-0929-B', 'outbound scale check failed', 'Expected 9.8 kg, measured 4.1 kg. Moved to exception cage E-2 for a recount.'),
    ('LH-20409', '2026-09-29 10:31', 'CMH', 'A-02', 'W-0929-B', 'picked', 'Bin A-02-11'),
    ('LH-20409', '2026-09-29 10:58', 'CMH', 'P7', 'W-0929-B', 'packed', 'Box size XL1'),
    ('LH-20409', '2026-09-29 10:59', 'CMH', 'P7', 'W-0929-B', 'label created', 'Parcelway Ground PW7731940548'),
    ('LH-20409', '2026-09-29 16:38', 'CMH', 'SCALE-2', 'W-0929-B', 'outbound scale check failed', 'Expected 14.2 kg, measured 8.0 kg. Moved to exception cage E-2 for a recount.'),
    ('LH-20411', '2026-09-29 10:36', 'CMH', 'B-07', 'W-0929-B', 'picked', 'Bin B-07-02'),
    ('LH-20411', '2026-09-29 11:01', 'CMH', 'P7', 'W-0929-B', 'packed', 'Box size S1'),
    ('LH-20411', '2026-09-29 11:02', 'CMH', 'P7', 'W-0929-B', 'label created', 'Parcelway Ground PW7731940551'),
    ('LH-20411', '2026-09-29 16:39', 'CMH', 'SCALE-2', 'W-0929-B', 'outbound scale check failed', 'Expected 1.6 kg, measured 0.9 kg. Moved to exception cage E-2 for a recount.'),
    ('LH-20420', '2026-09-29 10:47', 'CMH', 'D-03', 'W-0929-B', 'picked', 'Bin D-03-05'),
    ('LH-20420', '2026-09-29 11:09', 'CMH', 'P7', 'W-0929-B', 'packed', 'Box size XL2'),
    ('LH-20420', '2026-09-29 11:10', 'CMH', 'P7', 'W-0929-B', 'label created', 'Parcelway Ground PW7731940570'),
    ('LH-20420', '2026-09-29 16:41', 'CMH', 'SCALE-2', 'W-0929-B', 'outbound scale check failed', 'Expected 11.5 kg, measured 6.3 kg. Moved to exception cage E-2 for a recount.'),
    ('LH-20423', '2026-09-29 10:50', 'CMH', 'E-09', 'W-0929-B', 'picked', 'Bin E-09-01'),
    ('LH-20423', '2026-09-29 11:12', 'CMH', 'P7', 'W-0929-B', 'packed', 'Box size M1'),
    ('LH-20423', '2026-09-29 11:13', 'CMH', 'P7', 'W-0929-B', 'label created', 'Parcelway Ground PW7731940573'),
    ('LH-20423', '2026-09-29 16:42', 'CMH', 'SCALE-2', 'W-0929-B', 'outbound scale check failed', 'Expected 3.4 kg, measured 1.9 kg. Moved to exception cage E-2 for a recount.'),
    ('LH-20398', '2026-09-29 09:12', 'RNO', 'F-21', 'W-0929-A', 'picked', 'Bin F-21-07'),
    ('LH-20398', '2026-09-29 09:30', 'RNO', 'P2', 'W-0929-A', 'packed', 'Box size M2'),
    ('LH-20398', '2026-09-29 09:31', 'RNO', 'P2', 'W-0929-A', 'label created', 'Parcelway Ground PW7731938817'),
    ('LH-20398', '2026-09-29 15:05', 'RNO', 'SCALE-1', 'W-0929-A', 'outbound scale check passed', 'Expected 2.7 kg, measured 2.7 kg.'),
    ('LH-20398', '2026-09-29 17:20', 'RNO', 'DOCK-3', 'W-0929-A', 'handed to carrier', 'Parcelway trailer 4471'),
    ('LH-20431', '2026-09-30 13:02', 'ATL', 'G-04', 'W-0930-C', 'picked', 'Bin G-04-02'),
    ('LH-20431', '2026-09-30 13:25', 'ATL', 'P1', 'W-0930-C', 'packed', 'Box size M1'),
    ('LH-20431', '2026-09-30 13:26', 'ATL', 'P1', 'W-0930-C', 'label created', 'Parcelway Ground PW7731942290'),
    ('LH-20431', '2026-09-30 16:10', 'ATL', 'SCALE-1', 'W-0930-C', 'outbound scale check passed', 'Expected 3.1 kg, measured 3.1 kg.'),
    ('LH-20431', '2026-09-30 18:00', 'ATL', 'DOCK-1', 'W-0930-C', 'handed to carrier', 'Parcelway trailer 2208'),
    ('LH-20455', '2026-10-02 08:40', 'RNO', 'K-11', 'W-1002-A', 'picked', 'Bin K-11-04'),
    ('LH-20455', '2026-10-02 09:02', 'RNO', 'P3', 'W-1002-A', 'packed', 'Box size M1'),
    ('LH-20455', '2026-10-02 09:03', 'RNO', 'P3', 'W-1002-A', 'label created', 'Parcelway Ground PW7731947705'),
    ('LH-20455', '2026-10-02 14:44', 'RNO', 'SCALE-1', 'W-1002-A', 'outbound scale check passed', 'Expected 2.3 kg, measured 2.3 kg.'),
    ('LH-20455', '2026-10-02 17:15', 'RNO', 'DOCK-3', 'W-1002-A', 'handed to carrier', 'Parcelway trailer 4519');

INSERT INTO shipments VALUES
    ('LH-20417', 'Parcelway', 'PW7731940562', 'Ground', '2026-09-29 11:06', NULL),
    ('LH-20409', 'Parcelway', 'PW7731940548', 'Ground', '2026-09-29 10:59', NULL),
    ('LH-20411', 'Parcelway', 'PW7731940551', 'Ground', '2026-09-29 11:02', NULL),
    ('LH-20420', 'Parcelway', 'PW7731940570', 'Ground', '2026-09-29 11:10', NULL),
    ('LH-20423', 'Parcelway', 'PW7731940573', 'Ground', '2026-09-29 11:13', NULL),
    ('LH-20398', 'Parcelway', 'PW7731938817', 'Ground', '2026-09-29 09:31', '2026-09-29 17:20'),
    ('LH-20431', 'Parcelway', 'PW7731942290', 'Ground', '2026-09-30 13:26', '2026-09-30 18:00'),
    ('LH-20455', 'Parcelway', 'PW7731947705', 'Ground', '2026-10-02 09:03', '2026-10-02 17:15');

INSERT INTO carrier_events VALUES
    ('PW7731940562', '2026-09-29 11:06', 'Columbus, OH', 'Label created, waiting for the parcel'),
    ('PW7731940548', '2026-09-29 10:59', 'Columbus, OH', 'Label created, waiting for the parcel'),
    ('PW7731940551', '2026-09-29 11:02', 'Columbus, OH', 'Label created, waiting for the parcel'),
    ('PW7731940570', '2026-09-29 11:10', 'Columbus, OH', 'Label created, waiting for the parcel'),
    ('PW7731940573', '2026-09-29 11:13', 'Columbus, OH', 'Label created, waiting for the parcel'),
    ('PW7731938817', '2026-09-29 09:31', 'Reno, NV', 'Label created, waiting for the parcel'),
    ('PW7731938817', '2026-09-29 17:48', 'Reno, NV', 'Picked up'),
    ('PW7731938817', '2026-09-30 22:15', 'Salt Lake City, UT', 'Arrived at hub'),
    ('PW7731938817', '2026-10-01 19:40', 'Cheyenne, WY', 'Delayed: road closure for snow, held at hub'),
    ('PW7731938817', '2026-10-05 07:55', 'Cheyenne, WY', 'Departed hub'),
    ('PW7731938817', '2026-10-05 21:30', 'Denver, CO', 'Arrived at local depot'),
    ('PW7731942290', '2026-09-30 13:26', 'Atlanta, GA', 'Label created, waiting for the parcel'),
    ('PW7731942290', '2026-09-30 18:31', 'Atlanta, GA', 'Picked up'),
    ('PW7731942290', '2026-10-05 14:12', 'Chicago, IL', 'Delivered'),
    ('PW7731947705', '2026-10-02 09:03', 'Reno, NV', 'Label created, waiting for the parcel'),
    ('PW7731947705', '2026-10-02 17:40', 'Reno, NV', 'Picked up'),
    ('PW7731947705', '2026-10-04 11:20', 'Portland, OR', 'Arrived at hub');

INSERT INTO inventory VALUES
    ('KIT-ESP-DUO', 'CMH', 0),
    ('KIT-ESP-DUO', 'RNO', 14),
    ('KIT-ESP-DUO', 'ATL', 3),
    ('BED-LIN-QN', 'RNO', 22),
    ('BED-LIN-QN', 'CMH', 9),
    ('DIN-OAK-BEN', 'CMH', 0),
    ('DIN-OAK-BEN', 'ATL', 2),
    ('KIT-KNF-3', 'CMH', 31),
    ('LMP-ARC-BRS', 'CMH', 0),
    ('LMP-ARC-BRS', 'RNO', 5),
    ('BTH-TWL-6', 'CMH', 44),
    ('BTH-TWL-6', 'RNO', 18),
    ('LMP-TBL-CER', 'ATL', 12),
    ('KIT-PAN-12', 'RNO', 27);

INSERT INTO transit VALUES
    ('CMH', 'OR', 'Ground', 5), ('CMH', 'OR', 'Express', 2),
    ('RNO', 'OR', 'Ground', 3), ('RNO', 'OR', 'Express', 2),
    ('ATL', 'OR', 'Ground', 5), ('ATL', 'OR', 'Express', 3),
    ('CMH', 'CO', 'Ground', 4), ('CMH', 'CO', 'Express', 2),
    ('RNO', 'CO', 'Ground', 3), ('RNO', 'CO', 'Express', 1),
    ('ATL', 'CO', 'Ground', 4), ('ATL', 'CO', 'Express', 2),
    ('CMH', 'TX', 'Ground', 4), ('CMH', 'TX', 'Express', 2),
    ('ATL', 'TX', 'Ground', 3), ('ATL', 'TX', 'Express', 1),
    ('RNO', 'TX', 'Ground', 4), ('RNO', 'TX', 'Express', 2),
    ('CMH', 'OH', 'Ground', 1), ('CMH', 'OH', 'Express', 1),
    ('CMH', 'GA', 'Ground', 2), ('CMH', 'GA', 'Express', 1),
    ('RNO', 'GA', 'Ground', 5), ('RNO', 'GA', 'Express', 2),
    ('ATL', 'GA', 'Ground', 1), ('ATL', 'GA', 'Express', 1),
    ('CMH', 'NV', 'Ground', 5), ('CMH', 'NV', 'Express', 2),
    ('RNO', 'NV', 'Ground', 1), ('RNO', 'NV', 'Express', 1),
    ('ATL', 'IL', 'Ground', 2), ('RNO', 'WA', 'Ground', 3);
