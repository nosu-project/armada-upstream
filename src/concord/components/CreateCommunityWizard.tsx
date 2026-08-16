import { ImagePlus, Loader2, Pencil, Plus, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { ArmadaCrest } from "@/components/brand/ArmadaCrest";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ImageCropDialog } from "@/components/ImageCropDialog";
import { RelayListEditor } from "@/components/RelayListEditor";
import { WizardShell } from "@/components/onboarding/WizardShell";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useCommunityActions, useCreateRelayCandidates } from "@/concord/hooks/useCommunityActions";
import { ownAvServers } from "@/concord/hooks/useVoice";
import { canonicalOrigin } from "@/concord/lib/voice";
import { faviconUrl } from "@/lib/faviconUrl";
import { COMMUNITY_TIMER_PRESETS, DEFAULT_MESSAGE_EXPIRATION_SECS } from "@/concord/lib/disappearing";
import { encryptImageBlob } from "@/concord/lib/image";
import {
  DESCRIPTION_MAX_BYTES,
  MAX_COMMUNITY_AV_BROKERS,
  NAME_MAX_BYTES,
  utf8Len,
  type ImagePointer,
} from "@/concord/lib/types";
import { useUploadFile } from "@/hooks/useUploadFile";
import { toast } from "@/hooks/useToast";
import { cn } from "@/lib/utils";

/**
 * One concern per step: what it's called, what it looks like, where it lives,
 * how long it remembers. These used to share a single dialog screen, where a
 * name field, a retention timer and a relay list read as one undifferentiated
 * stack.
 *
 * "Where it lives" carries both lists a community is addressed by — relays for
 * its messages, voice servers for its calls — since they are one question and
 * one editor shape. The timer stays a step of its own: the relay editor is five
 * rows tall, and stacked with the create button it pushed it off the bottom of
 * a phone. The short step goes last, so the irreversible action is never the
 * thing that needs scrolling to.
 */
const CREATE_STEPS = ["name", "look", "relays", "rules"] as const;
type CreateStep = (typeof CREATE_STEPS)[number];

/** An uploaded image: the sealed pointer, plus the local plaintext to show. */
interface StagedImage {
  pointer: ImagePointer;
  /** Object URL of the cropped plaintext — the ciphertext is all that shipped. */
  preview: string;
}

/**
 * Founding a Concord community, as a full-screen wizard.
 *
 * It used to be a form crammed into the Add dialog, which left no room to ask
 * for anything but a name — so every new community was born faceless, its icon,
 * banner and description a settings trip nobody took, and its home relays
 * folded away behind a chevron glued to the submit button.
 *
 * Every step's answers go into the SAME genesis metadata edition (see
 * `create`): nothing publishes until the final button, so abandoning the wizard
 * leaves no half-made community behind — only, at worst, an orphaned encrypted
 * blob on a media server, which is unreadable without the key that never
 * shipped.
 */
export function CreateCommunityWizard({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { create, isCreating } = useCommunityActions();
  const { mutateAsync: uploadFile } = useUploadFile();

  const [step, setStep] = useState<CreateStep>("name");
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState<StagedImage | null>(null);
  const [banner, setBanner] = useState<StagedImage | null>(null);
  const [uploading, setUploading] = useState<"icon" | "banner" | null>(null);

  // Disappearing messages (CORD-08), surfaced at creation on purpose:
  // retention is a decision a community should make before its first message.
  // Defaults to 30 days; "Off" is one of the presets.
  const [expiration, setExpiration] = useState(DEFAULT_MESSAGE_EXPIRATION_SECS);

  // Which relays the community is minted on. `null` = untouched (use the
  // configured default candidates); once the user edits the picker, `relays`
  // holds the explicit set for this mint only, leaving the standing setting
  // alone. Passing it at submit keeps what's shown identical to what's used.
  const [relays, setRelays] = useState<string[] | null>(null);
  const candidates = useCreateRelayCandidates();
  const effectiveRelays = relays ?? candidates;

  // The community's voice servers (CORD-02 §6). Prefilled with the creator's
  // own, because that is what the community would otherwise be minted with
  // silently — and once minted, every member's calls resolve from this list
  // rather than from their own setting (CORD-07 §5), which is a decision worth
  // showing the person making it. Emptying it is a real answer: it leaves
  // every member on their own server.
  const [avBrokers, setAvBrokers] = useState<string[]>(() =>
    ownAvServers()
      .map(canonicalOrigin)
      .filter((origin): origin is string => Boolean(origin))
      .slice(0, MAX_COMMUNITY_AV_BROKERS),
  );

  const nameTooLong = utf8Len(name.trim()) > NAME_MAX_BYTES;
  const descriptionTooLong = utf8Len(description.trim()) > DESCRIPTION_MAX_BYTES;

  // Every object URL this wizard minted, revoked together on unmount. The
  // previews outlive their own step (step 2 can be returned to), so they can't
  // be revoked at the end of the handler that made them.
  const objectUrls = useRef<string[]>([]);
  useEffect(() => {
    const urls = objectUrls.current;
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  const pickInputRef = useRef<HTMLInputElement>(null);
  const pendingField = useRef<"icon" | "banner">("icon");
  const [cropState, setCropState] = useState<{
    imageSrc: string;
    aspect: number;
    field: "icon" | "banner";
    title: string;
  } | null>(null);

  const handlePickImage = (field: "icon" | "banner") => {
    pendingField.current = field;
    pickInputRef.current?.click();
  };

  const handleFileChosen = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const field = pendingField.current;
    setCropState({
      imageSrc: URL.createObjectURL(file),
      // The icon renders in a square, the banner in the 3:1 strip the community
      // pages give it — cropped here so neither is letterboxed.
      aspect: field === "icon" ? 1 : 3,
      field,
      title: field === "icon" ? "Crop icon" : "Crop banner",
    });
  };

  const handleCropCancel = () => {
    if (cropState) URL.revokeObjectURL(cropState.imageSrc);
    setCropState(null);
  };

  const handleCropConfirm = async (blob: Blob) => {
    if (!cropState) return;
    const { field, imageSrc } = cropState;
    URL.revokeObjectURL(imageSrc);
    setCropState(null);
    setError(null);
    setUploading(field);
    try {
      // CORD-02 §6: the media host only ever sees ciphertext; the per-image key
      // rides inside the member-sealed metadata edition published at the end.
      const { ciphertext, key, nonce, hash } = await encryptImageBlob(blob);
      const tags = await uploadFile(
        new File([ciphertext], `${field}.enc`, { type: "application/octet-stream" }),
      );
      const url = tags[0]?.[1];
      if (!url) throw new Error("Upload returned no URL.");
      const preview = URL.createObjectURL(blob);
      objectUrls.current.push(preview);
      const staged: StagedImage = { pointer: { url, key, nonce, hash }, preview };
      if (field === "icon") setIcon(staged);
      else setBanner(staged);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setUploading(null);
    }
  };

  const handleCreate = async () => {
    setError(null);
    try {
      // New communities are always Concord.
      const { communityId, name: created } = await create({
        name: name.trim(),
        // Always the set shown on the previous step, so the community is minted
        // on exactly the relays the user was told about (create derives the same
        // default from config when this is empty).
        relays: effectiveRelays,
        // Exactly the list the previous step showed, empty included.
        avBrokers,
        messageExpirationSecs: expiration,
        description: description.trim() || undefined,
        icon: icon?.pointer,
        banner: banner?.pointer,
      });
      toast({ title: "Encrypted community ready", description: created });
      // Replaced, not pushed: going back from a brand-new community must not
      // land on a filled-in wizard whose button would mint a second one.
      navigate(`/c/${encodeURIComponent(communityId)}`, { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the community.");
    }
  };

  const back: Record<CreateStep, (() => void) | undefined> = {
    name: undefined,
    look: () => setStep("name"),
    relays: () => setStep("look"),
    rules: () => setStep("relays"),
  };

  return (
    <WizardShell
      index={CREATE_STEPS.indexOf(step)}
      total={CREATE_STEPS.length}
      stepKey={step}
      maxWidth={step === "name" ? "max-w-sm" : "max-w-md"}
      onBack={back[step]}
      onClose={isCreating ? undefined : onClose}
    >
      {step === "name" && (
        <div className="flex flex-col items-center gap-8 text-center">
          <ArmadaCrest size={84} />

          {/* The Add dialog is now just a door, so the case for an encrypted
              community is made here, where it has room and isn't in the way. */}
          <StepHeading
            title="name your community"
            description="Serverless and end-to-end-encrypted. No host can read it, and you become the owner."
          />

          <div className="w-full space-y-3">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim() && !nameTooLong) {
                  e.preventDefault();
                  setStep("look");
                }
              }}
              placeholder="e.g. Midnight Fleet"
              aria-label="Community name"
              autoComplete="off"
              autoFocus
              className="h-12 text-base"
            />
            {nameTooLong && (
              <p className="text-left text-xs text-destructive">
                Names are capped at {NAME_MAX_BYTES} bytes. Shorten it to continue.
              </p>
            )}
            <Button
              type="button"
              size="lg"
              onClick={() => setStep("look")}
              disabled={!name.trim() || nameTooLong}
              className="h-12 w-full clip-corner-lg text-base font-medium"
            >
              Continue
            </Button>
          </div>
        </div>
      )}

      {step === "look" && (
        <div className="flex flex-col gap-6">
          <StepHeading
            title="give it a face"
            description="All optional. Images are encrypted before upload."
          />

          {/* A live stand-in for the community's own header, so what's being
              picked is shown in the composition it will be seen in: the icon
              punches through the banner's bottom edge rather than floating in a
              block of its own underneath it. */}
          <div>
            <div className="relative">
              <ImageSlot
                variant="banner"
                image={banner}
                busy={uploading === "banner"}
                onPick={() => handlePickImage("banner")}
              />
              {/* Half the icon's own height below the banner, so the overlap
                  stays centred on the edge whatever either one measures. */}
              <div className="absolute -bottom-10 left-1/2 -translate-x-1/2">
                <ImageSlot
                  variant="icon"
                  image={icon}
                  busy={uploading === "icon"}
                  onPick={() => handlePickImage("icon")}
                />
              </div>
            </div>
            {/* Clears the icon's overhang (40px) with room to spare. */}
            <h2 className="mt-12 text-center text-lg font-semibold leading-tight break-words">
              {name.trim()}
            </h2>
          </div>

          <div className="space-y-1.5">
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What's this community about?"
              aria-label="Community description"
              rows={3}
              className="resize-none"
            />
            {descriptionTooLong && (
              <p className="text-xs text-destructive">
                Descriptions are capped at {DESCRIPTION_MAX_BYTES.toLocaleString()} bytes.
              </p>
            )}
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Button
            type="button"
            size="lg"
            onClick={() => setStep("relays")}
            disabled={uploading !== null || descriptionTooLong}
            className="h-12 w-full clip-corner-lg text-base font-medium"
          >
            {uploading ? (
              <><Loader2 className="size-4 mr-2 animate-spin" /> Uploading...</>
            ) : (
              "Continue"
            )}
          </Button>
        </div>
      )}

      {step === "relays" && (
        <div className="flex flex-col gap-6">
          <StepHeading
            title="where it lives"
            description="Messages live on the relays; calls run through the voice servers. Pick relays that will let you post."
          />

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Relays
            </p>
            <RelayListEditor
              relays={effectiveRelays}
              onChange={setRelays}
              onReset={() => setRelays(candidates)}
              emptyText="Add at least one relay to host this community."
            />
          </div>

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Voice servers
            </p>
            <VoiceServerListEditor servers={avBrokers} onChange={setAvBrokers} />
            <p className="text-xs text-muted-foreground">
              {avBrokers.length > 0
                ? "Every call in this community runs through these. They never see the calls themselves, which are encrypted end to end, but they do see who connects and when."
                : "With none set, every member calls through whatever voice server they've set themselves."}
            </p>
          </div>

          <Button
            type="button"
            size="lg"
            onClick={() => setStep("rules")}
            disabled={effectiveRelays.length === 0}
            className="h-12 w-full clip-corner-lg text-base font-medium"
          >
            Continue
          </Button>
        </div>
      )}

      {step === "rules" && (
        <div className="flex flex-col gap-6">
          <StepHeading
            title="disappearing messages"
            description="Messages delete for everyone this long after they're sent. Changeable later."
          />

          <Select value={String(expiration)} onValueChange={(v) => setExpiration(Number(v))}>
            <SelectTrigger className="h-12 w-full text-base" aria-label="Disappearing messages timer">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[260]">
              {COMMUNITY_TIMER_PRESETS.map((p) => (
                <SelectItem key={p.seconds} value={String(p.seconds)}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Button
            type="button"
            size="lg"
            onClick={handleCreate}
            disabled={isCreating || effectiveRelays.length === 0}
            className="h-12 w-full clip-corner-lg text-base font-medium"
          >
            {isCreating ? (
              <><Loader2 className="size-4 mr-2 animate-spin" /> Creating...</>
            ) : (
              <><ShieldCheck className="size-4 mr-2" /> Create encrypted community</>
            )}
          </Button>
        </div>
      )}

      {/* One input for both slots — `pendingField` says which asked. Outside the
          steps so a re-render mid-pick can't unmount it under the file dialog. */}
      <input
        ref={pickInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChosen}
      />
      {cropState && (
        <ImageCropDialog
          open
          imageSrc={cropState.imageSrc}
          aspect={cropState.aspect}
          title={cropState.title}
          onCancel={handleCropCancel}
          onCrop={handleCropConfirm}
        />
      )}
    </WizardShell>
  );
}

/**
 * The voice-server list, in the relay editor's shape: an identity row per
 * server, a remove button, an add form that validates on submit, and a cap
 * past which the form goes away. Not `RelayListEditor` itself, because its
 * rows are a NIP-11 lookup — name, AUTH/search badges — and a broker publishes
 * no document to look up; it answers one capability probe and nothing else.
 *
 * So the icon is the host's **favicon**, through the same service template
 * Ditto uses (`faviconUrl`), and the fallback is the host's initial: the shape
 * of a relay row without inventing metadata the protocol doesn't define. A
 * broken or missing favicon degrades to that initial on its own, so nothing
 * here distinguishes "no icon" from "not a website".
 */
function VoiceServerListEditor({
  servers,
  onChange,
}: {
  servers: string[];
  onChange: (servers: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  const handleAdd = () => {
    const raw = draft.trim();
    // A bare host is the common way to type one; anything not https is refused,
    // the token grant being a bearer credential (CORD-07 §2).
    const origin = canonicalOrigin(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!origin) {
      toast({
        title: "Invalid voice server",
        description: "Enter an https address, like voice.example.com.",
        variant: "destructive",
      });
      return;
    }
    if (servers.includes(origin)) {
      toast({ title: "Already in the list", description: origin });
      setDraft("");
      return;
    }
    onChange([...servers, origin]);
    setDraft("");
  };

  return (
    <div className="space-y-1.5">
      {servers.map((origin) => {
        const host = origin.replace(/^https:\/\//, "");
        return (
          <div key={origin} className="flex items-center gap-2 rounded-md bg-background/40 px-3 py-2.5">
            <Avatar className="size-7 shrink-0 rounded-md">
              <AvatarImage src={faviconUrl(origin)} alt="" />
              <AvatarFallback className="rounded-md bg-secondary text-xs text-secondary-foreground">
                {host.charAt(0).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="min-w-0 flex-1 truncate font-mono text-sm">{host}</span>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${origin}`}
              className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
              onClick={() => onChange(servers.filter((s) => s !== origin))}
            >
              <X className="size-4" />
            </Button>
          </div>
        );
      })}

      {servers.length === 0 && (
        <p className="py-1 text-sm text-muted-foreground">
          No voice servers. Members will use their own.
        </p>
      )}

      {servers.length < MAX_COMMUNITY_AV_BROKERS && (
        <form
          className="flex gap-2 pt-1"
          onSubmit={(e) => {
            e.preventDefault();
            handleAdd();
          }}
        >
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="voice.example.com"
            aria-label="Add voice server"
            autoComplete="off"
            className="bg-background/40 border-transparent text-base md:text-sm"
          />
          <Button type="submit" disabled={!draft.trim()} className="clip-corner-lg shrink-0">
            <Plus className="size-4 mr-1.5" /> Add
          </Button>
        </form>
      )}
    </div>
  );
}

/** A step's title and its one line of framing, in the shell's voice. */
function StepHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-2.5 text-center">
      <h1 className="font-mono text-2xl font-bold lowercase tracking-tight text-foreground">
        {title}
      </h1>
      <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
    </div>
  );
}

/**
 * An icon or banner slot. Geometry is per-variant rather than passed in: there
 * are exactly two of these, and the icon's ring, its letter fallback and the
 * size of its overlay badge all have to agree with each other.
 *
 * The pencil appears only once there's something to replace — while the slot is
 * empty the add glyph is already the affordance, and stacking a second one on
 * top of it was what made the pair look lopsided.
 */
function ImageSlot({
  variant,
  image,
  busy,
  onPick,
}: {
  variant: "icon" | "banner";
  image: StagedImage | null;
  busy: boolean;
  onPick: () => void;
}) {
  const isIcon = variant === "icon";
  return (
    <div className={cn("relative", isIcon ? "w-fit" : "w-full")}>
      <button
        type="button"
        className={cn(
          "grid place-items-center overflow-hidden transition-colors",
          // The ring punches the icon out of the banner it overlaps.
          isIcon ? "size-20 rounded-2xl ring-4 ring-background" : "h-32 w-full rounded-lg",
          image
            ? "hover:opacity-90"
            : "bg-secondary/40 text-muted-foreground hover:bg-secondary/60",
        )}
        onClick={onPick}
        disabled={busy}
        aria-label={image ? `Change ${variant}` : `Add ${variant}`}
      >
        {image ? (
          <img src={image.preview} alt="" className="size-full object-cover" />
        ) : (
          <ImagePlus className={isIcon ? "size-4" : "size-5"} />
        )}
      </button>
      {(image || busy) && (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute grid place-items-center rounded-full bg-background/85 text-foreground ring-1 ring-border backdrop-blur",
            isIcon ? "-bottom-1 -right-1 size-6" : "bottom-2 right-2 size-8",
          )}
        >
          {busy ? (
            <Loader2 className={cn("animate-spin", isIcon ? "size-3" : "size-4")} />
          ) : (
            <Pencil className={isIcon ? "size-3" : "size-3.5"} />
          )}
        </div>
      )}
    </div>
  );
}
