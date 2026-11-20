function createStore() {
  let value = [];
  const listeners = new Set();
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set(next) {
      if (next.length === value.length && next.every((item, index) => sameAction(item, value[index]))) return;
      value = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

const sameAction = (left, right) => left.id === right.id && left.label === right.label
  && left.disabled === right.disabled && left.danger === right.danger;

export function makeNativeMenu(React, kind) {
  const { useId, useLayoutEffect, useRef } = React;
  const instances = new Map();
  let menus;

  function attach(contextMenus) {
    menus = contextMenus;
    const unregister = menus.register({
      id: kind, target: kind, order: 0,
      observe: ({ id }) => {
        const instance = instances.get(id);
        return instance ? [instance.store] : [];
      },
      resolve({ id }) {
        const instance = instances.get(id);
        if (!instance) return [];
        // A captured menu can outlive its view; re-check the action's current
        // availability at selection time instead of trusting what was painted.
        return instance.current().map(({ run, ...action }) => ({
          ...action,
          run: run && !action.disabled ? () => {
            if (instances.get(id) !== instance) return;
            const latest = instance.current().find((candidate) => candidate.id === action.id);
            if (!latest || latest.disabled) return;
            return (latest.run ?? run)();
          } : undefined,
        }));
      },
    });
    return () => {
      unregister();
      if (menus === contextMenus) menus = undefined;
    };
  }

  function useTarget(active, getActions, scope, signal) {
    const id = useId();
    const latest = useRef(getActions);
    useLayoutEffect(() => { latest.current = getActions; });
    const entry = useRef(null);
    if (entry.current === null) {
      const store = createStore();
      entry.current = { store, current: () => latest.current(), publish: () => store.set(latest.current()) };
    }
    useLayoutEffect(() => {
      if (!active || signal?.aborted) return;
      const instance = entry.current;
      instances.set(id, instance);
      function dispose() {
        if (instances.get(id) !== instance) return;
        instances.delete(id);
        const target = menus?.active.getSnapshot();
        if (target?.kind === kind && target.value.id === id) menus.close();
      }
      signal?.addEventListener('abort', dispose, { once: true });
      return () => {
        signal?.removeEventListener('abort', dispose);
        dispose();
      };
    }, [active, id, scope, signal]);
    // Publish the committed action list so an open native menu refreshes its
    // labels and availability instead of showing a stale snapshot.
    useLayoutEffect(() => {
      if (active && !signal?.aborted) entry.current.publish();
    });
    return { kind, value: { id } };
  }

  return { attach, useTarget };
}
