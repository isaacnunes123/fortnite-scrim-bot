type LiveEvent = { type: string; scrimId?: string };

type Listener = (event: LiveEvent) => void;

const listeners = new Set<Listener>();

export function publish(event: LiveEvent): void {
  for (const listener of listeners) {
    listener(event);
  }
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
