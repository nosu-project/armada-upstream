import { Plus } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { useNavigate } from "react-router-dom";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { ImportFromDiscordButton } from "@/components/ImportFromDiscord";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { cn } from "@/lib/utils";

const AddDialog = lazy(() =>
  import("@/components/dialogs/AddDialog").then((m) => ({ default: m.AddDialog })),
);

/** First Discover tile: found your own community. Signed-out visitors go to the welcome page. */
export function CreateCommunityCard({ className }: { className?: string }) {
  const { user } = useCurrentUser();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const onCreate = () => {
    if (user) setOpen(true);
    else navigate("/");
  };

  return (
    <div
      className={cn(
        "flex w-full flex-col overflow-hidden rounded-xl border border-primary/25 bg-[hsl(var(--chrome-deep)/0.55)]",
        className,
      )}
    >
      <div className="relative flex aspect-[3/1] w-full shrink-0 items-center justify-center overflow-hidden bg-chrome">
        <div
          aria-hidden
          className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,hsl(var(--primary)/0.14),transparent_65%)]"
        />
        <ArmadaCrest size={64} className="drop-shadow-[0_8px_24px_hsl(var(--primary)/0.25)]" />
      </div>

      <div className="flex flex-1 flex-col gap-2.5 px-3.5 py-3">
        <div className="min-w-0">
          <p className="font-mono font-bold lowercase tracking-tight leading-tight">
            create your own
          </p>
          <p className="text-[11px] text-muted-foreground">
            An encrypted community for your crew — no server, no host.
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          Yours in seconds. Invite people when you're ready.
        </p>
        <Button className="mt-auto w-full clip-corner-lg" onClick={onCreate}>
          <Plus className="size-4" />
          Create community
        </Button>
        <ImportFromDiscordButton size="sm" />
      </div>

      <ArmadaCrestKeyframes />
      {open && (
        <Suspense fallback={null}>
          <AddDialog open={open} onOpenChange={setOpen} />
        </Suspense>
      )}
    </div>
  );
}
