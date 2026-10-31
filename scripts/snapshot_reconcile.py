"""Bounded, checkpoint-first first-parent inventory for the sole publisher."""
from copy import deepcopy

from snapshot_admission import SHA


def initial(anchor):
    if not isinstance(anchor, str) or not SHA.fullmatch(anchor):
        raise ValueError('invalid anchor')
    return {'version': 1, 'anchor': anchor, 'cursor': anchor, 'pending': []}


def reconcile(state, anchor, history, publish, save, batch=10):
    if (not isinstance(state, dict) or set(state) != {'version', 'anchor', 'cursor', 'pending'}
            or type(state['version']) is not int or state['version'] != 1 or state['anchor'] != anchor
            or not isinstance(anchor, str) or not SHA.fullmatch(anchor)
            or not isinstance(history, list) or anchor not in history
            or any(not isinstance(x, str) or not SHA.fullmatch(x) for x in history)
            or len(set(history)) != len(history) or state['cursor'] not in history
            or not isinstance(state['pending'], list)
            or any(not isinstance(x, str) or not SHA.fullmatch(x) for x in state['pending'])
            or len(set(state['pending'])) != len(state['pending'])
            or not isinstance(batch, int) or batch < 2):
        raise ValueError('invalid reconciliation checkpoint or history')
    oldest = list(reversed(history[:history.index(anchor) + 1]))
    if state['cursor'] not in oldest:
        raise ValueError('checkpoint cursor is not after anchor on main')
    cursor = oldest.index(state['cursor'])
    if any(x not in oldest[1:cursor + 1] for x in state['pending']):
        raise ValueError('pending revision outside checkpoint range')
    state = deepcopy(state)
    new = oldest[cursor + 1:cursor + 1 + batch // 2]
    if new:
        state['pending'].extend(new)
        state['cursor'] = new[-1]
        save(deepcopy(state))
    count = min(batch, len(state['pending']))
    for _ in range(count):
        revision = state['pending'][0]
        if publish(revision):
            state['pending'].pop(0)
        else:
            state['pending'].append(state['pending'].pop(0))
        save(deepcopy(state))
    return state
