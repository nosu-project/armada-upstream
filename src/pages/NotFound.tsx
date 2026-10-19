import { Compass } from "lucide-react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { FormattedMessage } from "@/i18n";

export function NotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <Compass className="size-12 text-muted-foreground/50" />
      <h1 className="text-3xl font-bold">404</h1>
      <p className="text-muted-foreground">
        <FormattedMessage id="notFound.message" defaultMessage="This page drifted off the map." />
      </p>
      <Button asChild>
        <Link to="/">
          <FormattedMessage id="notFound.backToBase" defaultMessage="Back to base" />
        </Link>
      </Button>
    </div>
  );
}
