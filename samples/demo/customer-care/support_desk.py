"""The customer specialist's tools: read-only lookups on the made-up Larkfield Home support desk (support.sqlite).

Every function prints what it found, because only printed output reaches the specialist.
"""
import os
import sqlite3
from datetime import date

DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'support.sqlite')
# The demo's complaints arrive on this day, so "days before" stays the same whenever the demo runs.
COMPLAINT_DAY = date(2026, 10, 6)
REPEAT_WINDOW_DAYS = 120


def _connect():
    db = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    return db


def query(sql, params=()):
    """Runs one read-only SQL statement and returns (column names, rows)."""
    with _connect() as db:
        cursor = db.execute(sql, params)
        return [c[0] for c in cursor.description or []], [tuple(row) for row in cursor.fetchall()]


def _days_before(day):
    return (COMPLAINT_DAY - date.fromisoformat(day)).days


def _customer(db, order_id=None, email=None):
    if order_id:
        return db.execute(
            'SELECT c.* FROM customers c JOIN orders o ON o.customer_id = c.id WHERE o.id = ?', (order_id.strip().upper(),)
        ).fetchone()
    if email:
        return db.execute('SELECT * FROM customers WHERE lower(email) = lower(?)', (email.strip(),)).fetchone()
    return None


def account_snapshot(order_id=None, email=None):
    """Prints the account behind an order number or an email: tier, orders, late deliveries and every past contact."""
    with _connect() as db:
        customer = _customer(db, order_id, email)
        if not customer:
            print(f'No customer found for order {order_id or "-"} or email {email or "-"}.')
            return
        orders = db.execute('SELECT * FROM orders WHERE customer_id = ? ORDER BY placed_on', (customer['id'],)).fetchall()
        contacts = db.execute('SELECT * FROM contacts WHERE customer_id = ? ORDER BY contacted_on', (customer['id'],)).fetchall()
    delivered = [o for o in orders if o['status'] == 'delivered']
    print(f"Customer {customer['id']}: {customer['name']} <{customer['email']}>, {customer['city']}, {customer['state']}")
    print(f"Tier: {customer['tier']}, member since {customer['member_since']}")
    print(f"Orders: {len(orders)} ({len(delivered)} delivered), lifetime spend ${sum(o['total'] for o in orders):,.2f}")
    print(f'Complaint day: {COMPLAINT_DAY.isoformat()}')
    print('Orders, newest first:')
    for o in reversed(orders):
        late = ''
        if o['delivered_on'] and o['delivered_on'] > o['promised_by']:
            late = f", LATE by {(date.fromisoformat(o['delivered_on']) - date.fromisoformat(o['promised_by'])).days} days"
        elif not o['delivered_on'] and o['promised_by'] < COMPLAINT_DAY.isoformat():
            late = ', not delivered, past its promised date'
        delivered_on = o['delivered_on'] or 'not yet'
        print(f"  {o['id']}: placed {o['placed_on']}, promised {o['promised_by']}, delivered {delivered_on}, ${o['total']:.2f}{late}")
    print('Past contacts:')
    if not contacts:
        print('  none')
    for c in contacts:
        credit = f" Credit given: ${c['credit']:.2f} ({c['credit_type']})." if c['credit'] else ''
        print(
            f"  {c['contacted_on']} ({_days_before(c['contacted_on'])} days before the complaint), {c['channel']}, "
            f"{c['reason']}{', order ' + c['order_id'] if c['order_id'] else ''}: {c['summary']}{credit}"
        )
    recent_late = [
        o
        for o in delivered
        if o['delivered_on'] > o['promised_by'] and _days_before(o['delivered_on']) <= REPEAT_WINDOW_DAYS
    ]
    if recent_late:
        names = ', '.join(f"{o['id']} (delivered {o['delivered_on']}, {_days_before(o['delivered_on'])} days before)" for o in recent_late)
        print(f'Late deliveries in the {REPEAT_WINDOW_DAYS} days before the complaint: {names}')
    else:
        print(f'Late deliveries in the {REPEAT_WINDOW_DAYS} days before the complaint: none')
