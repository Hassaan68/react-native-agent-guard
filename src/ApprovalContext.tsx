import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { ToolRegistry } from './registry';
import type { ApprovalRequest } from './types';

interface PendingApprovalItem {
  request: ApprovalRequest;
  resolve: (approved: boolean) => void;
}

export interface AgentApprovalContextValue {
  /** The active approval request at the front of the FIFO queue, or `null` if idle. */
  currentRequest: ApprovalRequest | null;
  /** Total number of pending approval requests currently in the FIFO queue. */
  queueLength: number;
  /** Approve the `currentRequest` and advance the FIFO queue. */
  approve: () => void;
  /** Deny the `currentRequest` and advance the FIFO queue. */
  deny: () => void;
}

const AgentApprovalContext = createContext<AgentApprovalContextValue | null>(
  null,
);

export interface AgentApprovalProviderProps {
  /** The `ToolRegistry` instance whose `'confirm'` requests will be queued and managed. */
  registry: ToolRegistry;
  children: React.ReactNode;
}

/**
 * Headless provider that connects a `ToolRegistry` to a React FIFO approval queue.
 * Pair with `useAgentApproval()` for custom UIs or drop in `<AgentApprovalSheet />`.
 */
export const AgentApprovalProvider: React.FC<AgentApprovalProviderProps> = ({
  registry,
  children,
}) => {
  const [queue, setQueue] = useState<PendingApprovalItem[]>([]);

  useEffect(() => {
    const handleApproval = (request: ApprovalRequest): Promise<boolean> => {
      return new Promise<boolean>((resolve) => {
        setQueue((prev) => [...prev, { request, resolve }]);
      });
    };

    registry.setApprovalHandler(handleApproval);

    return () => {
      registry.setApprovalHandler(undefined);
    };
  }, [registry]);

  const approve = useCallback(() => {
    setQueue((prev) => {
      if (prev.length === 0) {
        return prev;
      }
      const [head, ...rest] = prev;
      if (head) {
        head.resolve(true);
      }
      return rest;
    });
  }, []);

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

  const value = useMemo<AgentApprovalContextValue>(
    () => ({
      currentRequest: queue[0]?.request ?? null,
      queueLength: queue.length,
      approve,
      deny,
    }),
    [queue, approve, deny],
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
