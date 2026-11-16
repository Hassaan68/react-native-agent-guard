import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { ToolRegistry } from './registry';
import type {
  ApprovalRequest,
  ApprovalResolution,
  QueueStorageAdapter,
  SerializedQueuedRequest,
} from './types';

interface PendingApprovalItem {
  request: ApprovalRequest;
  resolve: (resolution: ApprovalResolution) => void;
}

export interface AgentApprovalContextValue {
  /** The active approval request at the front of the FIFO queue, or `null` if idle. */
  currentRequest: ApprovalRequest | null;
  /** Total number of pending approval requests currently in the FIFO queue. */
  queueLength: number;
  /**
   * Approve the `currentRequest` and advance the FIFO queue.
   * Optionally pass `grantDurationMs` (e.g. `300_000` for 5 minutes or `'session'`) to create a time-bound `SessionGrant`.
   */
  approve: (
    grantDurationMs?: number | 'session',
    options?: { maxCalls?: number },
  ) => void;
  /** Deny the `currentRequest` and advance the FIFO queue. */
  deny: () => void;
  /** Hydrate pending approval requests from `queueStorage` and prune expired entries. */
  hydratePendingQueue?: () => Promise<SerializedQueuedRequest[]>;
  /** Prune expired approval requests (`Date.now() >= expiresAt`) from the queue. */
  pruneExpiredRequests?: () => Promise<SerializedQueuedRequest[]>;
}

const AgentApprovalContext = createContext<AgentApprovalContextValue | null>(
  null,
);

export interface AgentApprovalProviderProps {
  /** The `ToolRegistry` instance whose `'confirm'` requests will be queued and managed. */
  registry: ToolRegistry;
  /** Optional persistent queue storage adapter for offline/background approval persistence. */
  queueStorage?: QueueStorageAdapter;
  /** Optional default approval TTL in milliseconds. */
  approvalTimeoutMs?: number;
  children: React.ReactNode;
}

/** Alias for `AgentApprovalProviderProps`. */
export type ApprovalProviderProps = AgentApprovalProviderProps;

/**
 * Headless provider that connects a `ToolRegistry` to a React FIFO approval queue.
 * Pair with `useAgentApproval()` for custom UIs or drop in `<AgentApprovalSheet />`.
 */
export const AgentApprovalProvider: React.FC<AgentApprovalProviderProps> = ({
  registry,
  queueStorage,
  children,
}) => {
  const [queue, setQueue] = useState<PendingApprovalItem[]>([]);

  useEffect(() => {
    const handleApproval = (
      request: ApprovalRequest,
    ): Promise<ApprovalResolution> => {
      return new Promise<ApprovalResolution>((resolve) => {
        setQueue((prev) => [...prev, { request, resolve }]);
      });
    };

    const removeRequest = (requestId: string) => {
      setQueue((prev) =>
        prev.filter((item) => item.request.id !== requestId),
      );
    };

    registry.setApprovalHandler(handleApproval);
    registry.setQueueHooks({
      queueStorage,
      removeRequest,
    });

    return () => {
      registry.setApprovalHandler(undefined);
      registry.setQueueHooks({});
    };
  }, [registry, queueStorage]);

  const approve = useCallback(
    (
      grantDurationMs?: number | 'session',
      options?: { maxCalls?: number },
    ) => {
      setQueue((prev) => {
        if (prev.length === 0) {
          return prev;
        }
        const [head, ...rest] = prev;
        if (head) {
          if (
            grantDurationMs !== undefined ||
            options?.maxCalls !== undefined
          ) {
            head.resolve({
              approved: true,
              ...(grantDurationMs !== undefined ? { grantDurationMs } : {}),
              ...(options?.maxCalls !== undefined
                ? { maxCalls: options.maxCalls }
                : {}),
            });
          } else {
            head.resolve(true);
          }
        }
        return rest;
      });
    },
    [],
  );

  const deny = useCallback(() => {
    setQueue((prev) => {
      if (prev.length === 0) {
        return prev;
      }
      const [head, ...rest] = prev;
      if (head) {
        head.resolve(false);
      }
      return rest;
    });
  }, []);

  const hydratePendingQueue = useCallback(async () => {
    return registry.hydratePendingQueue();
  }, [registry]);

  const pruneExpiredRequests = useCallback(async () => {
    return registry.pruneExpiredRequests();
  }, [registry]);

  const value = useMemo<AgentApprovalContextValue>(
    () => ({
      currentRequest: queue[0]?.request ?? null,
      queueLength: queue.length,
      approve,
      deny,
      hydratePendingQueue,
      pruneExpiredRequests,
    }),
    [queue, approve, deny, hydratePendingQueue, pruneExpiredRequests],
  );

  return (
    <AgentApprovalContext.Provider value={value}>
      {children}
    </AgentApprovalContext.Provider>
  );
};

/**
 * Headless hook returning `{ currentRequest, queueLength, approve, deny }`
 * from the nearest `<AgentApprovalProvider>`.
 */
export function useAgentApproval(): AgentApprovalContextValue {
  const context = useContext(AgentApprovalContext);
  if (!context) {
    throw new Error(
      'useAgentApproval must be used within an <AgentApprovalProvider>.',
    );
  }
  return context;
}

/**
 * Alias for `useAgentApproval()` returning `{ currentRequest, queueLength, approve, deny }`
 * from the nearest `<AgentApprovalProvider>`.
 */
export const useApprovalRequest = useAgentApproval;
