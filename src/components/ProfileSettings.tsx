import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Loader2, Plus, Trash2, ChevronDown, ChevronUp,
  Wallet, Upload, Music, ImageIcon, Film, Mail, Link2, Pencil, AlertTriangle, Save,
} from 'lucide-react';
import { useForm, useFieldArray, type Control } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { NSchema as n } from '@nostrify/nostrify';
import type { NostrMetadata } from '@nostrify/nostrify';
import { useQueryClient } from '@tanstack/react-query';

import { ProfileCard } from '@/components/ProfileCard';
import { ImageCropDialog } from '@/components/ImageCropDialog';
import { PaymentTargetsEditor, type PaymentTargetsEditorHandle } from '@/components/PaymentTargetsEditor';
import { useCurrentUserProfile } from '@/hooks/useCurrentUser';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { useUploadFile } from '@/hooks/useUploadFile';
import { useUploadProfileImage } from '@/hooks/useUploadProfileImage';
import { profileImetaTags } from '@/lib/profileImeta';
import { useToast } from '@/hooks/useToast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { isValidAvatarShape } from '@/lib/avatarShape';
import { isAnimatedImage, METADATA_SCAN_BYTES } from '@/lib/imageMetadata';

const WALLET_TICKERS = [
  '$BTC', '$ETH', '$SOL', '$XMR', '$LTC', '$DOGE', '$ADA', '$DOT', '$XRP', '$MATIC',
] as const;

/** Bare tickers used only for detection (strips leading $). */
const BARE_TICKERS = WALLET_TICKERS.map((t) => t.slice(1));

interface FieldPreset {
  id: string;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  defaultLabel: string;
  type: 'text' | 'wallet' | 'media';
  accept?: string;
  formatHint?: string;
  valuePlaceholder?: string;
}

const FIELD_PRESETS: FieldPreset[] = [
  {
    id: 'music',
    label: 'Music',
    description: 'Upload a song or audio clip',
    icon: Music,
    defaultLabel: '\u{1F3B6}',
    type: 'media',
    accept: 'audio/*',
    formatHint: 'MP3, OGG, WAV, FLAC, AAC, M4A, Opus',
    valuePlaceholder: 'Upload audio or paste direct file link',
  },
  {
    id: 'photo',
    label: 'Photo',
    description: 'Upload an image',
    icon: ImageIcon,
    defaultLabel: '\u{1F4F8}',
    type: 'media',
    accept: 'image/*',
    formatHint: 'JPG, PNG, GIF, WebP, SVG, AVIF',
    valuePlaceholder: 'Upload image or paste direct file link',
  },
  {
    id: 'video',
    label: 'Video',
    description: 'Upload a video clip',
    icon: Film,
    defaultLabel: '\u{1F3AC}',
    type: 'media',
    accept: 'video/*',
    formatHint: 'MP4, WebM, MOV',
    valuePlaceholder: 'Upload video or paste direct file link',
  },
  {
    id: 'email',
    label: 'Email',
    description: 'Contact email address',
    icon: Mail,
    defaultLabel: 'Email',
    type: 'text',
    valuePlaceholder: 'you@example.com',
  },
  {
    id: 'wallet',
    label: 'Wallet',
    description: 'Cryptocurrency wallet address',
    icon: Wallet,
    defaultLabel: '$BTC',
    type: 'wallet',
    valuePlaceholder: 'Address',
  },
  {
    id: 'link',
    label: 'Link',
    description: 'Link to any website or profile',
    icon: Link2,
    defaultLabel: '',
    type: 'text',
    valuePlaceholder: 'https://...',
  },
];

const CUSTOM_PRESET: FieldPreset = {
  id: 'custom',
  label: 'Custom',
  description: 'Create any custom field',
  icon: Pencil,
  defaultLabel: '',
  type: 'text',
  valuePlaceholder: 'Value or URL',
};

function getFormatHintForAccept(accept: string | undefined): string | undefined {
  if (!accept) return undefined;
  const preset = FIELD_PRESETS.find((p) => p.accept === accept);
  return preset?.formatHint;
}

function inferFieldType(label: string, value: string): 'text' | 'wallet' | 'media' {
  const bare = label.replace(/^\$/, '').toUpperCase();
  if (BARE_TICKERS.includes(bare)) return 'wallet';
  if (/^https?:\/\/.+\.(jpe?g|png|gif|webp|svg|avif|mp4|webm|mov|mp3|ogg|wav|flac)(\?.*)?$/i.test(value)) return 'media';
  // Blossom-style URLs: SHA-256 hex path, optional extension.
  if (/^https?:\/\/.+\/[0-9a-f]{64}(\.\w+)?$/i.test(value)) return 'media';
  return 'text';
}

const AUDIO_EXT = /\.(mp3|mpga|ogg|oga|wav|flac|aac|m4a|opus|weba|webm|spx|caf)(\?.*)?$/i;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|svg|avif)(\?.*)?$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|qt)(\?.*)?$/i;

/** Warning when a pasted URL doesn't match the media field's accept type; undefined if fine or not a URL. */
function getMediaMismatchWarning(value: string, accept: string | undefined): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) return undefined;

  // Blossom URLs can't reveal type.
  if (/^https?:\/\/.+\/[0-9a-f]{64}(\.\w+)?$/i.test(trimmed)) return undefined;

  const hasAudioExt = AUDIO_EXT.test(trimmed);
  const hasImageExt = IMAGE_EXT.test(trimmed);
  const hasVideoExt = VIDEO_EXT.test(trimmed);
  const hasKnownExt = hasAudioExt || hasImageExt || hasVideoExt;

  if (accept === 'audio/*') {
    if (hasKnownExt && !hasAudioExt) {
      return 'This URL doesn\u2019t point to an audio file. Upload an audio file or use a direct link ending in .mp3, .ogg, .wav, etc.';
    }
    if (!hasKnownExt) {
      return 'This URL may not work as an audio player. For best results, upload a file using the button or paste a direct link to an audio file.';
    }
  }

  if (accept === 'image/*') {
    if (hasKnownExt && !hasImageExt) {
      return 'This URL doesn\u2019t point to an image. Upload an image or use a direct link ending in .jpg, .png, .webp, etc.';
    }
    if (!hasKnownExt) {
      return 'This URL may not display as an image. For best results, upload a file using the button or paste a direct link to an image file.';
    }
  }

  if (accept === 'video/*') {
    if (hasKnownExt && !hasVideoExt) {
      return 'This URL doesn\u2019t point to a video. Upload a video or use a direct link ending in .mp4, .webm, .mov, etc.';
    }
    if (!hasKnownExt) {
      return 'This URL may not display as a video. For best results, upload a file using the button or paste a direct link to a video file.';
    }
  }

  return undefined;
}

function inferAcceptFromValue(value: string): string | undefined {
  if (/\.(mp3|mpga|ogg|oga|wav|flac|aac|m4a|opus|weba|webm|spx|caf)(\?.*)?$/i.test(value)) return 'audio/*';
  if (/\.(jpe?g|png|gif|webp|svg|avif)(\?.*)?$/i.test(value)) return 'image/*';
  if (/\.(mp4|webm|mov|qt)(\?.*)?$/i.test(value)) return 'video/*';
  return undefined;
}

const formSchema = n.metadata().extend({
  fields: z.array(z.object({
    label: z.string(),
    value: z.string(),
    type: z.enum(['text', 'wallet', 'media']),
    /** Client-side only (not persisted). */
    accept: z.string().optional(),
    /** Client-side only (not persisted). */
    placeholder: z.string().optional(),
  })),
  shape: z.string().optional(),
});

type FormValues = z.infer<typeof formSchema>;
type FieldEntry = NonNullable<FormValues['fields']>[number];

type CropState = {
  imageSrc: string;
  aspect: number;
  field: 'picture' | 'banner';
  title: string;
};

interface FieldRowProps {
  index: number;
  type: 'text' | 'wallet' | 'media';
  accept?: string;
  valuePlaceholder?: string;
  isUploading?: boolean;
  control: Control<FormValues>;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onMediaPick: () => void;
  onTickerChange: (ticker: string) => void;
}

function FieldRow({
  index, type, accept, valuePlaceholder, isUploading: fieldUploading, control,
  canMoveUp, canMoveDown, onRemove, onMoveUp, onMoveDown, onMediaPick, onTickerChange,
}: FieldRowProps) {
  const formatHint = type === 'media' ? getFormatHintForAccept(accept) : undefined;

  return (
    <div className="grid grid-cols-[auto,1fr,2fr,auto] gap-2 items-start">
      <div className="flex flex-col">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-[18px] w-6 text-muted-foreground disabled:opacity-30"
          disabled={!canMoveUp}
          onClick={onMoveUp}
          aria-label="Move field up"
        >
          <ChevronUp className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-[18px] w-6 text-muted-foreground disabled:opacity-30"
          disabled={!canMoveDown}
          onClick={onMoveDown}
          aria-label="Move field down"
        >
          <ChevronDown className="size-3.5" />
        </Button>
      </div>

      {type === 'wallet' ? (
        <FormField
          control={control}
          name={`fields.${index}.label`}
          render={({ field }) => (
            <FormItem>
              <Select value={field.value} onValueChange={(v) => { field.onChange(v); onTickerChange(v); }}>
                <FormControl>
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Ticker" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {WALLET_TICKERS.map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
      ) : (
        <FormField
          control={control}
          name={`fields.${index}.label`}
          render={({ field }) => (
            <FormItem>
              <FormControl>
                <Input placeholder="Label" {...field} className="h-9" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      )}

      {type === 'media' ? (
        <FormField
          control={control}
          name={`fields.${index}.value`}
          render={({ field }) => {
            const mismatchWarning = getMediaMismatchWarning(field.value, accept);
            return (
              <FormItem>
                <div className="flex gap-1.5">
                  <FormControl>
                    <Input placeholder={valuePlaceholder || 'Upload file or paste direct file link'} {...field} className="h-9 flex-1 min-w-0" />
                  </FormControl>
                  {fieldUploading ? (
                    <div className="flex items-center justify-center h-9 w-9 shrink-0">
                      <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    </div>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-9 w-9 shrink-0"
                          onClick={onMediaPick}
                        >
                          <Upload className="size-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs max-w-52">
                        {formatHint ? (
                          <span>Choose file to upload<br /><span className="text-muted-foreground">{formatHint}</span></span>
                        ) : (
                          <span>Choose a media file to upload</span>
                        )}
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
                {mismatchWarning && (
                  <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-500 mt-1 leading-snug">
                    <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
                    <span>{mismatchWarning}</span>
                  </p>
                )}
                <FormMessage />
              </FormItem>
            );
          }}
        />
      ) : (
        <FormField
          control={control}
          name={`fields.${index}.value`}
          render={({ field }) => (
            <FormItem>
              <FormControl>
                <Input placeholder={type === 'wallet' ? 'Address' : 'Value or URL'} {...field} className="h-9" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      )}

      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onRemove}
        className="h-9 w-9 text-destructive hover:text-destructive"
      >
        <Trash2 className="size-4" />
      </Button>
    </div>
  );
}

interface ProfileSettingsProps {
  onSaved?: () => void;
  saveLabel?: string;
  centerSave?: boolean;
  showNip05?: boolean;
}

/** WYSIWYG kind-0 editor: an editable {@link ProfileCard} plus typed custom fields. */
export function ProfileSettings({ onSaved, saveLabel, centerSave, showNip05 = true }: ProfileSettingsProps = {}) {
  const { user, metadata, event, imeta: profileImeta } = useCurrentUserProfile();
  const queryClient = useQueryClient();
  const { mutateAsync: publishEvent, isPending } = useNostrPublish();
  const { mutateAsync: uploadFile, isPending: isUploadingMedia } = useUploadFile();
  const { upload: uploadProfileImage, isPending: isUploadingImage } = useUploadProfileImage();
  const isUploading = isUploadingMedia || isUploadingImage;
  // imeta for each picture/banner uploaded this session, offered to the kind 0 on save.
  const uploadedImeta = useRef<string[][]>([]);
  const { toast } = useToast();

  const [cropState, setCropState] = useState<CropState | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [uploadingFieldIndex, setUploadingFieldIndex] = useState<number>(-1);
  const paymentTargetsRef = useRef<PaymentTargetsEditorHandle>(null);

  const parseFields = (): Array<{ label: string; value: string; type: 'text' | 'wallet' | 'media'; accept?: string }> => {
    if (!event) return [];
    try {
      const parsed = JSON.parse(event.content);
      if (Array.isArray(parsed.fields)) {
        return parsed.fields
          .filter((f: unknown) => Array.isArray(f) && f.length >= 2)
          .map((f: string[]) => {
            const type = inferFieldType(f[0], f[1]);
            // `$` prefix so the Select value matches.
            const label = type === 'wallet' && !f[0].startsWith('$')
              ? `$${f[0].toUpperCase()}`
              : f[0];
            const accept = type === 'media' ? inferAcceptFromValue(f[1]) : undefined;
            return { label, value: f[1], type, accept };
          });
      }
    } catch { /* ignore */ }
    return [];
  };

  const parseShape = (): string => {
    if (!event) return '';
    try {
      const parsed = JSON.parse(event.content);
      if (isValidAvatarShape(parsed.shape)) return parsed.shape;
    } catch { /* ignore */ }
    return '';
  };

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: '', about: '', picture: '', banner: '',
      website: '', nip05: '', lud16: '', lud06: '', bot: false, fields: [],
      shape: '',
    },
  });

  // `n.metadata()` adds an index signature that breaks FieldArrayPath
  // inference, so cast to a shape with just the array field.
  const fieldArrayControl = form.control as unknown as Control<{ fields: FieldEntry[] }>;
  const { fields, append, remove, move } = useFieldArray({ control: fieldArrayControl, name: 'fields' });

  const mediaInputRef = useRef<HTMLInputElement>(null);
  const pendingMediaIndex = useRef<number>(-1);
  const handleMediaPick = (index: number) => {
    pendingMediaIndex.current = index;
    const fieldAccept = form.getValues(`fields.${index}.accept`);
    if (mediaInputRef.current) {
      mediaInputRef.current.accept = fieldAccept || 'image/*,video/*,audio/*';
    }
    mediaInputRef.current?.click();
  };
  const handleMediaFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    const index = pendingMediaIndex.current;
    if (index < 0) return;
    setUploadingFieldIndex(index);
    try {
      const [[, url]] = await uploadFile(file);
      form.setValue(`fields.${index}.value`, url, { shouldDirty: true });
      toast({ title: 'Uploaded', description: 'Media file uploaded' });
    } catch {
      toast({ title: 'Upload failed', description: 'Please try again.', variant: 'destructive' });
    } finally {
      setUploadingFieldIndex(-1);
    }
  };

  useEffect(() => {
    if (metadata) {
      form.reset({
        name: metadata.name ?? '',
        about: metadata.about ?? '',
        picture: metadata.picture ?? '',
        banner: metadata.banner ?? '',
        website: metadata.website ?? '',
        nip05: metadata.nip05 ?? '',
        lud16: metadata.lud16 ?? '',
        lud06: metadata.lud06 ?? '',
        bot: metadata.bot ?? false,
        fields: parseFields(),
        shape: parseShape(),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metadata, event]);

  const watched = form.watch();
  const cardMetadata: Partial<NostrMetadata> & { shape?: string } = {
    name: watched.name,
    about: watched.about,
    picture: watched.picture,
    banner: watched.banner,
    website: watched.website,
    nip05: watched.nip05,
    lud16: watched.lud16,
    lud06: watched.lud06,
    bot: watched.bot,
    shape: watched.shape,
  };

  const handleCardChange = (patch: Partial<NostrMetadata>) => {
    for (const [k, v] of Object.entries(patch)) {
      form.setValue(k as keyof FormValues, v as string, { shouldDirty: true });
    }
  };

  const pickInputRef = useRef<HTMLInputElement>(null);
  const pendingField = useRef<'picture' | 'banner'>('picture');

  const handlePickImage = (field: 'picture' | 'banner') => {
    pendingField.current = field;
    pickInputRef.current?.click();
  };

  const uploadImage = async (file: File, field: 'picture' | 'banner') => {
    try {
      const { url, imeta } = await uploadProfileImage(file);
      uploadedImeta.current.unshift(imeta);
      form.setValue(field, url, { shouldDirty: true });
      toast({ title: 'Uploaded', description: `${field === 'picture' ? 'Profile picture' : 'Banner'} updated` });
    } catch {
      toast({ title: 'Upload failed', description: 'Please try again.', variant: 'destructive' });
    }
  };

  const handleFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    const field = pendingField.current;

    // Animated images would be flattened by the crop canvas; upload them as-is.
    const head = new Uint8Array(await file.slice(0, METADATA_SCAN_BYTES).arrayBuffer());
    if (isAnimatedImage(file.type, head)) {
      await uploadImage(file, field);
      return;
    }

    setCropState({
      imageSrc: URL.createObjectURL(file),
      aspect: field === 'picture' ? 1 : 3,
      field,
      title: field === 'picture' ? 'Crop Profile Picture' : 'Crop Banner',
    });
  };

  const handleCropConfirm = async (blob: Blob) => {
    if (!cropState) return;
    const { field, imageSrc } = cropState;
    URL.revokeObjectURL(imageSrc);
    setCropState(null);
    const file = new File([blob], `${field}.jpg`, { type: 'image/jpeg' });
    await uploadImage(file, field);
  };

  const handleCropCancel = () => {
    if (cropState) URL.revokeObjectURL(cropState.imageSrc);
    setCropState(null);
  };

  const handleAddPreset = (preset: FieldPreset) => {
    append({
      label: preset.defaultLabel,
      value: '',
      type: preset.type,
      accept: preset.accept,
      placeholder: preset.valuePlaceholder,
    });
  };

  const moveField = useCallback((from: number, to: number) => {
    if (to < 0 || to >= fields.length) return;
    move(from, to);
  }, [fields.length, move]);

  const onSubmit = async (values: FormValues) => {
    if (!user) {
      toast({ title: 'Error', description: 'You must be logged in to update your profile.', variant: 'destructive' });
      return;
    }
    try {
      const { fields: customFields, shape, ...standardMetadata } = values;
      const data: Record<string, unknown> = { ...metadata, ...standardMetadata };

      if (shape && isValidAvatarShape(shape)) {
        data.shape = shape;
      } else {
        delete data.shape;
      }

      for (const key in data) {
        if (data[key] === '') delete data[key];
      }
      if (customFields && customFields.length > 0) {
        const nonEmpty = customFields.filter((f) => f.label.trim() && f.value.trim());
        if (nonEmpty.length > 0) data.fields = nonEmpty.map((f) => [f.label, f.value]);
      }
      await publishEvent({
        kind: 0,
        content: JSON.stringify(data),
        tags: profileImetaTags(data, [...uploadedImeta.current, ...(event?.tags ?? [])]),
        prev: event,
      });
      queryClient.invalidateQueries({ queryKey: ['logins'] });
      queryClient.invalidateQueries({ queryKey: ['author', user.pubkey] });

      // On failure the editor toasts its own error; skip the success toast.
      const targetsSaved = (await paymentTargetsRef.current?.save()) ?? true;
      if (!targetsSaved) return;

      toast({ title: 'Profile saved' });
      onSaved?.();
    } catch {
      toast({ title: 'Error', description: 'Failed to save profile.', variant: 'destructive' });
    }
  };

  const busy = isPending || isUploading;

  if (!user) {
    return (
      <p className="text-sm text-muted-foreground">
        Log in to edit your profile.
      </p>
    );
  }

  return (
    <>
      <input
        ref={pickInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChosen}
      />
      <input
        ref={mediaInputRef}
        type="file"
        accept="image/*,video/*,audio/*"
        className="hidden"
        onChange={handleMediaFileChosen}
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

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">

          <ProfileCard
            pubkey={user.pubkey}
            metadata={cardMetadata}
            imeta={profileImeta}
            onChange={handleCardChange}
            onPickImage={handlePickImage}
            onAvatarShape={(shape) => form.setValue('shape', shape, { shouldDirty: true })}
            onRemoveAvatar={() => form.setValue('picture', '', { shouldDirty: true })}
            showNip05={showNip05}
          />

          {isUploading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Uploading…
            </div>
          )}

          <Collapsible open={showAdvanced} onOpenChange={setShowAdvanced}>
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" className="w-full justify-start gap-1.5 px-0 py-1 h-auto text-muted-foreground hover:bg-transparent hover:text-foreground">
                <span className="text-xs font-medium">More</span>
                <ChevronDown className="size-3.5 text-muted-foreground transition-transform duration-200 [[data-state=open]_&]:rotate-180" strokeWidth={4} />
              </Button>
            </CollapsibleTrigger>
            {/* Padding on the inner wrapper: Radix measures the content box, so padding here jumps on collapse. */}
            <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
              <div className="pt-3 space-y-4">
                <div>
                  <h2 className="text-sm font-medium py-2">Profile Fields</h2>

                  <div className="space-y-3 pt-1">
                    <FormField
                      control={form.control}
                      name="website"
                      render={({ field }) => (
                        <div className="grid grid-cols-[auto,1fr,2fr,auto] gap-2 items-center">
                          <div className="w-6" />
                          <div className="flex items-center h-9 px-3 text-sm text-muted-foreground">
                            <span>Website</span>
                          </div>
                          <Input placeholder="https://yourwebsite.com" {...field} className="h-9" />
                          <div className="size-9" />
                        </div>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="lud16"
                      render={({ field }) => (
                        <div className="grid grid-cols-[auto,1fr,2fr,auto] gap-2 items-center">
                          <div className="w-6" />
                          <div className="flex items-center h-9 px-3 text-sm text-muted-foreground">
                            <span>Lightning</span>
                          </div>
                          <Input placeholder="you@walletofsatoshi.com" {...field} className="h-9" />
                          <div className="size-9" />
                        </div>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="lud06"
                      render={({ field }) => (
                        <div className="grid grid-cols-[auto,1fr,2fr,auto] gap-2 items-center">
                          <div className="w-6" />
                          <div className="flex items-center h-9 px-3 text-sm text-muted-foreground">
                            <span>LNURL</span>
                          </div>
                          <Input placeholder="lnurl1…" {...field} className="h-9" />
                          <div className="size-9" />
                        </div>
                      )}
                    />

                    {fields.map((field, index) => (
                      <FieldRow
                        key={field.id}
                        index={index}
                        type={form.watch(`fields.${index}.type`) ?? 'text'}
                        accept={form.watch(`fields.${index}.accept`)}
                        valuePlaceholder={form.watch(`fields.${index}.placeholder`)}
                        isUploading={uploadingFieldIndex === index}
                        control={form.control}
                        canMoveUp={index > 0}
                        canMoveDown={index < fields.length - 1}
                        onRemove={() => remove(index)}
                        onMoveUp={() => moveField(index, index - 1)}
                        onMoveDown={() => moveField(index, index + 1)}
                        onMediaPick={() => handleMediaPick(index)}
                        onTickerChange={(ticker) => form.setValue(`fields.${index}.label`, ticker, { shouldDirty: true })}
                      />
                    ))}

                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {[...FIELD_PRESETS, CUSTOM_PRESET].map((preset) => {
                        const Icon = preset.icon;
                        return (
                          <Tooltip key={preset.id}>
                            <TooltipTrigger asChild>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                // Opaque over the onboarding wizard's ASCII background.
                              className="h-7 rounded-full px-3 text-xs gap-1.5 bg-background"
                                onClick={() => handleAddPreset(preset)}
                              >
                                <Plus className="size-3 text-muted-foreground" />
                                <Icon className="size-3.5 text-muted-foreground" />
                                {preset.label}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" className="text-xs">
                              {preset.description}
                            </TooltipContent>
                          </Tooltip>
                        );
                      })}
                    </div>
                  </div>
                </div>

                <FormField
                  control={form.control}
                  name="bot"
                  render={({ field }) => (
                    <FormItem className="flex items-center justify-between rounded-lg border bg-card p-3">
                      <div>
                        <FormLabel className="text-sm">Bot Account</FormLabel>
                        <FormDescription className="text-xs">Mark this account as automated</FormDescription>
                      </div>
                      <FormControl>
                        <Switch checked={field.value} onCheckedChange={field.onChange} />
                      </FormControl>
                    </FormItem>
                  )}
                />

                <PaymentTargetsEditor ref={paymentTargetsRef} />
              </div>
            </CollapsibleContent>
          </Collapsible>

          <div className={centerSave ? 'flex justify-center' : undefined}>
            <Button type="submit" disabled={busy} className="w-full sm:w-auto clip-corner-lg">
              {busy ? <><Loader2 className="size-4 mr-2 animate-spin" /> Saving…</> : <><Save className="size-4 mr-2" /> {saveLabel ?? 'Save Profile'}</>}
            </Button>
          </div>

        </form>
      </Form>
    </>
  );
}
