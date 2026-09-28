import { useContext } from 'react';
import { EventStoreContext, type EventStoreContextType } from '@/contexts/EventStoreContext';

/**
 * The app-wide event store (ArmadaDB `main` tenant), as a Promise to `await` inside a
 * query function.
 */
export function useEventStore(): EventStoreContextType {
  const context = useContext(EventStoreContext);
  if (!context) {
    throw new Error('useEventStore must be used within an EventStoreProvider');
  }
  return context;
}
