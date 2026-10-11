"""The operations specialist's tools: read-only lookups on the made-up Larkfield Home fulfillment systems
(fulfillment.sqlite): warehouse scans, carrier tracking, stock and transit times.

Every function prints what it found, because only printed output reaches the specialist.
"""
import os
import sqlite3
from datetime import date, timedelta

DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fulfillment.sqlite')
# The demo's complaints arrive on this day, so reship dates stay the same whenever the demo runs.
TODAY = date(2026, 10, 6)


def _connect():
    db = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    return db


def query(sql, params=()):
    """Runs one read-only SQL statement and returns (column names, rows)."""
    with _connect() as db:
        cursor = db.execute(sql, params)
        return [c[0] for c in cursor.description or []], [tuple(row) for row in cursor.fetchall()]


def _add_business_days(start, days):
    day = start
    while days > 0:
        day += timedelta(days=1)
        if day.weekday() < 5:
            days -= 1
    return day


def trace_order(order_id):
    """Prints an order's journey: the items, every warehouse scan, the shipment and every carrier scan."""
    order_id = order_id.strip().upper()
    with _connect() as db:
        lines = db.execute('SELECT * FROM order_lines WHERE order_id = ?', (order_id,)).fetchall()
        if not lines:
            print(f'No order {order_id} in the fulfillment systems.')
            return
        events = db.execute('SELECT * FROM warehouse_events WHERE order_id = ? ORDER BY at', (order_id,)).fetchall()
        shipment = db.execute('SELECT * FROM shipments WHERE order_id = ?', (order_id,)).fetchone()
        scans = (
            db.execute('SELECT * FROM carrier_events WHERE tracking = ? ORDER BY at', (shipment['tracking'],)).fetchall()
            if shipment
            else []
        )
    print(f'Order {order_id}, as of {TODAY.isoformat()}')
    for line in lines:
        print(
            f"  {line['qty']} x {line['item']} ({line['sku']}), ${line['unit_price']:.2f}, shipping paid ${line['shipping_paid']:.2f}, "
            f"{line['service']} from {line['warehouse']} to {line['ship_to_city']}, {line['ship_to_state']}, promised by {line['promised_by']}"
        )
    print('Warehouse scans:')
    for e in events:
        where = ', '.join(part for part in [e['warehouse'], e['station'] and f"station {e['station']}", e['wave'] and f"wave {e['wave']}"] if part)
        print(f"  {e['at']} {e['event']} ({where}){': ' + e['detail'] if e['detail'] else ''}")
    if shipment:
        handed = shipment['handed_to_carrier_at'] or 'never'
        print(
            f"Shipment: {shipment['carrier']} {shipment['service']}, tracking {shipment['tracking']}, label created "
            f"{shipment['label_created_at']}, handed to carrier: {handed}"
        )
    print('Carrier scans:')
    for s in scans:
        print(f"  {s['at']} {s['location']}: {s['status']}")
    picked_up = [s for s in scans if s['status'] != 'Label created, waiting for the parcel']
    if not picked_up:
        print('The carrier has no scan after the label was created: it never received the parcel.')


def investigate(order_id):
    """Prints everything about one late order in a single call: its journey, the stock and reship dates for each item,
    and any other orders held in the same packing wave."""
    order_id = order_id.strip().upper()
    trace_order(order_id)
    with _connect() as db:
        lines = db.execute('SELECT sku, ship_to_state FROM order_lines WHERE order_id = ?', (order_id,)).fetchall()
        waves = db.execute(
            "SELECT DISTINCT wave FROM warehouse_events WHERE order_id = ? AND wave IS NOT NULL", (order_id,)
        ).fetchall()
        held = db.execute(
            """
            SELECT DISTINCT e.order_id FROM warehouse_events e
            WHERE e.wave IN (SELECT wave FROM warehouse_events WHERE order_id = ?) AND e.event LIKE '%failed%'
              AND e.order_id != ?
            ORDER BY e.order_id
            """,
            (order_id, order_id),
        ).fetchall()
    for line in lines:
        stock(line['sku'], line['ship_to_state'])
    wave_names = ', '.join(w['wave'] for w in waves) or 'none'
    if held:
        print(f"{len(held)} other orders held in the same packing wave ({wave_names}): {', '.join(h['order_id'] for h in held)}")
    else:
        print(f'No other order held in the same packing wave ({wave_names}).')


def held_orders():
    """Prints every open order whose last warehouse scan is a failed check, grouped by packing wave."""
    with _connect() as db:
        rows = db.execute(
            """
            SELECT e.order_id, e.at, e.warehouse, e.station, e.wave, e.event, e.detail
            FROM warehouse_events e
            JOIN (SELECT order_id, MAX(at) AS last_at FROM warehouse_events GROUP BY order_id) last
              ON last.order_id = e.order_id AND last.last_at = e.at
            WHERE e.event LIKE '%failed%'
            ORDER BY e.wave, e.order_id
            """
        ).fetchall()
    if not rows:
        print('No order is held in a warehouse.')
        return
    waves = {}
    for row in rows:
        waves.setdefault((row['warehouse'], row['wave']), []).append(row)
    for (warehouse, wave), held in waves.items():
        print(f'{len(held)} orders held in {warehouse}, packing wave {wave}:')
        for row in held:
            print(f"  {row['order_id']}: {row['event']} at {row['at']} ({row['station']}): {row['detail']}")


def stock(sku, ship_to_state):
    """Prints stock for a SKU in every warehouse and when a reship sent today would arrive, by service."""
    sku = sku.strip().upper()
    state = ship_to_state.strip().upper()
    with _connect() as db:
        rows = db.execute(
            """
            SELECT i.warehouse, w.name, i.on_hand, t.service, t.business_days
            FROM inventory i JOIN warehouses w ON w.code = i.warehouse
            LEFT JOIN transit t ON t.warehouse = i.warehouse AND t.state = ?
            WHERE i.sku = ? ORDER BY i.warehouse, t.business_days
            """,
            (state, sku),
        ).fetchall()
    if not rows:
        print(f'No stock record for {sku}.')
        return
    print(f'Stock for {sku}, shipping to {state}, if sent today ({TODAY.isoformat()}):')
    empty = set()
    for r in rows:
        if r['on_hand'] == 0:
            if r['warehouse'] not in empty:
                print(f"  {r['warehouse']} ({r['name']}): 0 on hand")
            empty.add(r['warehouse'])
            continue
        if r['service'] is None:
            print(f"  {r['warehouse']} ({r['name']}): {r['on_hand']} on hand, no transit time to {state}")
            continue
        arrives = _add_business_days(TODAY, r['business_days'])
        print(
            f"  {r['warehouse']} ({r['name']}): {r['on_hand']} on hand, {r['service']} {r['business_days']} business day{'s' if r['business_days'] != 1 else ''}, "
            f"arrives {arrives.isoformat()} ({arrives.strftime('%A')})"
        )
