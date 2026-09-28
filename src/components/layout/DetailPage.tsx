import { ArrowLeft } from "lucide-react";

import { ServerRail } from "@/components/layout/ServerRail";
import { Button } from "@/components/ui/button";
import { useBackOrHome } from "@/hooks/useBackOrHome";

import type { ReactNode } from "react";

interface DetailPageProps {
  title: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  /** Drawn inside `<main>`, over the body (e.g. the profile overlay). */
  overlay?: ReactNode;
}

/** Frame for a single linked item (person, theme, emoji pack): rail, header with back, centred column. */
export function DetailPage({ title, icon, children, overlay }: DetailPageProps) {
  // A cold load has nothing to go back to, so it lands home.
  const back = useBackOrHome();

  return (
    <>
      <ServerRail />
      <main className="relative flex-1 min-w-0 flex flex-col safe-area-top">
        <header className="relative h-12 touch:h-14 mx-2 mt-3 w-[calc(100%-1rem)] max-w-2xl sm:mx-auto px-2 sidebar:px-3 flex items-center gap-1.5 shrink-0 clip-corner-lg bg-chrome">
          <Button variant="ghost" size="icon" className="size-9 touch:size-11 shrink-0" aria-label="Back" onClick={back}>
            <ArrowLeft className="size-5" />
          </Button>
          {icon}
          <h1 className="min-w-0 flex-1 font-semibold truncate leading-tight">{title}</h1>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto safe-area-bottom">
          <div className="max-w-2xl mx-auto px-4 sm:px-6 pb-16 pt-4 space-y-4">{children}</div>
        </div>
        {overlay}
      </main>
    </>
  );
}
