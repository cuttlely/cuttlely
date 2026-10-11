"""The policy specialist's tool: the made-up Larkfield Home Service Recovery Policy (service-policy.md).

read_policy() prints the whole policy, or one numbered section. remedy_table() works out the remedy for every tier from
the policy's tables, so the amounts are exact. Both print, because only printed output reaches the specialist.
"""
import os
import re

POLICY = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'service-policy.md')


def read_policy(section=None):
    """Prints the whole policy, or the one section whose number is given ("2.3")."""
    with open(POLICY, encoding='utf-8') as handle:
        text = handle.read()
    if not section:
        print(text)
        return
    wanted = str(section).strip()
    match = re.search(rf'^### {re.escape(wanted)} .*?(?=^##|\Z)', text, flags=re.M | re.S)
    print(match.group(0).strip() if match else f'The policy has no section {wanted}.')


# The numbers in the policy tables (2.3, 2.4, 3.1). The demo tests check they match service-policy.md.
TIERS = ['Standard', 'Plus', 'Premier']
CREDIT_SHARE = {'Standard': 0.10, 'Plus': 0.15, 'Premier': 0.20}
CREDIT_CAP = 75.0
PREMIER_REPEAT_CAP = 100.0
GOODWILL = {'Standard': 10.0, 'Plus': 15.0, 'Premier': 25.0}


def _money(value):
    return f'${value:,.2f}'


def _common(fault, shipping_paid):
    if fault == 'larkfield':
        return [
            f'refund the shipping, {_money(shipping_paid)} (2.1)',
            'reship today at our cost by the fastest service, from the warehouse that delivers first (2.1)',
            'recall the held parcel so it is not shipped twice (2.1)',
            'if the customer asks for a refund, offer the reship or a full refund of the order and let them choose (3.2)',
        ]
    if fault == 'carrier':
        return [
            'open a trace with the carrier today (2.2)',
            'reship only after 3 business days with no carrier scan, or if the carrier declares the parcel lost (2.2)',
            'a goodwill credit only when the customer had none in the last 90 days (2.4)',
        ]
    return ["offer to resend at the customer's cost, with no credit (1.4)"]


def _remedy(fault, tier, repeat, item_price, shipping_paid):
    applied = TIERS[min(TIERS.index(tier) + 1, 2)] if repeat else tier
    steps = []
    if fault == 'larkfield':
        cap = PREMIER_REPEAT_CAP if (repeat and tier == 'Premier') else CREDIT_CAP
        credit = min(round(item_price * CREDIT_SHARE[applied], 2), cap)
        share = int(round(CREDIT_SHARE[applied] * 100))
        capped = f', capped at {_money(cap)}' if credit == cap else ''
        steps.append(f'store credit {_money(credit)} ({share}% of {_money(item_price)}{capped}, 2.3)')
        if applied == 'Premier':
            steps.append('a call from the Customer Care Lead (2.3) and escalate to the Customer Care Lead (3.3)')
    elif fault == 'carrier':
        steps.append(f'goodwill credit {_money(GOODWILL[applied])} (2.4)')
        steps.append(f'refund the shipping, {_money(shipping_paid)} (2.2)' if applied != 'Standard' else 'no shipping refund (2.2)')
        if applied == 'Premier':
            steps.append('escalate to the Customer Care Lead (3.3)')
    else:
        steps.append('no credit (1.4)')
    return applied, steps


def remedy_table(fault, item_price, shipping_paid, orders_held=0):
    """Prints the remedy for every tier, with and without another late delivery in the 120 days before (3.1).

    fault is "larkfield", "carrier" or "customer" (part 1). item_price and shipping_paid come from operations.
    orders_held is how many orders the same warehouse problem held, counting this one (3.3).
    """
    fault = str(fault).strip().lower()
    if fault not in ('larkfield', 'carrier', 'customer'):
        print('fault must be "larkfield", "carrier" or "customer".')
        return
    item_price, shipping_paid = float(item_price), float(shipping_paid)
    print(f'Remedy for a {fault}-fault late delivery, item {_money(item_price)}, shipping paid {_money(shipping_paid)}.')
    print('Every customer: ' + '; '.join(_common(fault, shipping_paid)) + '.')
    held = int(orders_held or 0)
    if fault == 'larkfield' and held > 3:
        print(f'Every customer: the same warehouse problem held {held} orders, more than 3, so open an operations incident naming the packing wave (3.3).')
    print('Then add the one line that matches the customer (tier, and another late delivery in the 120 days before or not):')
    for tier in TIERS:
        for repeat in (False, True):
            applied, steps = _remedy(fault, tier, repeat, item_price, shipping_paid)
            case = 'another late delivery in 120 days' if repeat else 'no other late delivery in 120 days'
            raised = ', raised one tier by 3.1' if applied != tier else ''
            print(f'- {tier}, {case}: {applied} remedy{raised}: ' + '; '.join(steps) + '.')
