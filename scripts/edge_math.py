from decimal import Decimal, getcontext

getcontext().prec = 40

def edge_bps(bid, ask, fees_bps=0, slip_bps=0, buffer_bps=2):
    if ask <= 0 or bid <= 0:
        return -1e9
    gross = (Decimal(bid) / Decimal(ask)) - Decimal(1)
    total_cost = Decimal(fees_bps + slip_bps + buffer_bps) / Decimal(1e4)
    return float((gross - total_cost) * Decimal(1e4))
