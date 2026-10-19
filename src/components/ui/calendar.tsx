import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { DayPicker, useDayPicker, type MonthCaptionProps } from "react-day-picker";
import { format, type Locale } from "date-fns";
import { de, enUS, es, fr, it, ja, nl } from "date-fns/locale";

import { useIntl } from "@/i18n";

import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button-variants";

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

const DATE_FNS_LOCALES: Record<string, Locale> = { de, en: enUS, es, fr, it, ja, nl };

/** The date-fns locale for an app language code (English when unknown). */
function dateFnsLocale(locale: string): Locale {
  return DATE_FNS_LOCALES[locale] ?? DATE_FNS_LOCALES[locale.split("-")[0]] ?? enUS;
}

/** Inline ◀ Month Year ▶ header; react-day-picker v9's default `nav` is hidden. */
function MonthCaption({ calendarMonth }: MonthCaptionProps) {
  const intl = useIntl();
  const { previousMonth, nextMonth, goToMonth } = useDayPicker();
  const navBtn = cn(
    buttonVariants({ variant: "ghost" }),
    "size-7 p-0 text-muted-foreground hover:text-foreground disabled:opacity-30",
  );
  return (
    <div className="flex items-center justify-between px-1 pb-2">
      <button
        type="button"
        className={navBtn}
        disabled={!previousMonth}
        onClick={() => previousMonth && goToMonth(previousMonth)}
        aria-label={intl.formatMessage({ id: "calendar.previousMonth", defaultMessage: "Previous month" })}
      >
        <ChevronLeft className="size-4" />
      </button>
      <span className="text-sm font-medium">{format(calendarMonth.date, "LLLL yyyy", { locale: dateFnsLocale(intl.locale) })}</span>
      <button
        type="button"
        className={navBtn}
        disabled={!nextMonth}
        onClick={() => nextMonth && goToMonth(nextMonth)}
        aria-label={intl.formatMessage({ id: "calendar.nextMonth", defaultMessage: "Next month" })}
      >
        <ChevronRight className="size-4" />
      </button>
    </div>
  );
}

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: CalendarProps) {
  const intl = useIntl();
  return (
    <DayPicker
      locale={dateFnsLocale(intl.locale)}
      showOutsideDays={showOutsideDays}
      className={cn("p-3", className)}
      classNames={{
        months: "flex flex-col sm:flex-row space-y-4 sm:space-x-4 sm:space-y-0",
        month: "space-y-2",
        nav: "hidden",
        month_caption: "",
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday:
          "text-muted-foreground rounded-md w-9 font-normal text-[0.8rem]",
        week: "flex w-full mt-2",
        day: "h-9 w-9 text-center text-sm p-0 relative [&:has([aria-selected].rdp-range_end)]:rounded-r-md [&:has([aria-selected].rdp-outside)]:bg-accent/50 [&:has([aria-selected].rdp-range_middle)]:bg-accent first:[&:has([aria-selected].rdp-range_middle)]:rounded-l-md last:[&:has([aria-selected].rdp-range_middle)]:rounded-r-md focus-within:relative focus-within:z-20",
        day_button: cn(
          buttonVariants({ variant: "ghost" }),
          "h-9 w-9 rounded-md p-0 font-normal aria-selected:opacity-100"
        ),
        range_end: "rdp-range_end",
        selected:
          "rounded-md [&>button]:bg-primary [&>button]:text-primary-foreground [&>button:hover]:bg-primary [&>button:hover]:text-primary-foreground",
        today: "rounded-md [&>button]:bg-accent [&>button]:text-accent-foreground",
        outside:
          "rdp-outside text-muted-foreground opacity-50 aria-selected:bg-accent/50 aria-selected:text-muted-foreground aria-selected:opacity-30",
        disabled: "text-muted-foreground opacity-50",
        range_middle:
          "aria-selected:bg-accent aria-selected:text-accent-foreground",
        hidden: "invisible",
        ...classNames,
      }}
      components={{
        MonthCaption,
      }}
      {...props}
    />
  );
}
Calendar.displayName = "Calendar";

export { Calendar };
