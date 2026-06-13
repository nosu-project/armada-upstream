// NOTE: This file should normally not be modified unless you are adding a new provider.
// To add new routes, edit the AppRouter.tsx file.

import { NostrLoginProvider } from "@nostrify/react/login";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { AppProvider } from "@/components/AppProvider";
import NostrProvider from "@/components/NostrProvider";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

import AppRouter from "./AppRouter";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 60000, // 1 minute
      gcTime: 300000, // 5 minutes
    },
  },
});

export function App() {
  return (
    <AppProvider storageKey="armada:app-config">
      <QueryClientProvider client={queryClient}>
        <NostrLoginProvider storageKey="armada:login">
          <NostrProvider>
            <TooltipProvider>
              <Toaster />
              <AppRouter />
            </TooltipProvider>
          </NostrProvider>
        </NostrLoginProvider>
      </QueryClientProvider>
    </AppProvider>
  );
}

export default App;
