"use client";

import { useState, type ReactNode } from "react";
import { ChevronUp } from "lucide-react";
import { Favicon } from "@/components/favicon";
import type { PlacementTargetRecord } from "@/lib/placements/read";
import { authorAvatar, businessAvatar, type AuthorAvatar as AuthorAvatarData } from "@/lib/placements/avatar";
import { imageUrlOf } from "@/lib/placements/media";
import { referencedUnreadLine, type ReferencedPost } from "@/lib/placements/referenced";
import { cn } from "@/lib/utils";
import { ageLabel, postMeta } from "@/components/placements/reply-logic";

/**
 * The open item as a post and the reply under it (2026-11-10): the
 * author's picture beside the post, the business's icon beside the draft,
 * and a thin line between the two, the way a thread reads on X. No card,
 * no new border: the pictures and the line are the only additions.
 */

/**
 * The initials circles' colours, picked by `avatarTone` (eight, as
 * AVATAR_TONE_COUNT says). Soft in both themes, the letters dark on light
 * and light on dark.
 */
export const AVATAR_TONES = [
  "bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200",
  "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200",
  "bg-lime-100 text-lime-800 dark:bg-lime-950/40 dark:text-lime-200",
  "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200",
  "bg-cyan-100 text-cyan-800 dark:bg-cyan-950/40 dark:text-cyan-200",
  "bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-200",
  "bg-violet-100 text-violet-800 dark:bg-violet-950/40 dark:text-violet-200",
  "bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-950/40 dark:text-fuchsia-200",
] as const;

export type BusinessIdentity = { name: string | null; domain: string | null } | null | undefined;

/**
 * A round picture with what stands under it. The initials (or the
 * platform's mark) are drawn first and the picture is laid over them once
 * it loads, so nothing waits on it; a picture that fails gives way to the
 * next one, then to what is under it. Lazy, no referrer, hidden from
 * assistive tech: the name beside it says who it is.
 */
export function Avatar({ data, size = 36, className }: { data: AuthorAvatarData; size?: number; className?: string }) {
  const [failed, setFailed] = useState(0);
  const src = data.images[failed];
  const small = size < 32;
  return (
    <span
      aria-hidden="true"
      data-avatar={src ? "image" : data.initials ? "initials" : data.mark ? "mark" : "blank"}
      className={cn("relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full", className)}
      style={{ width: size, height: size }}
    >
      {data.initials ? (
        <span
          className={cn(
            "flex h-full w-full items-center justify-center font-semibold",
            small ? "text-xs" : "text-sm",
            AVATAR_TONES[data.tone % AVATAR_TONES.length]
          )}
        >
          {data.initials}
        </span>
      ) : (
        <span className="flex h-full w-full items-center justify-center rounded-full border border-foreground/10 bg-background">
          {data.mark && <Favicon domain={data.mark} size={Math.round(size * 0.55)} />}
        </span>
      )}
      {src && (
        // eslint-disable-next-line @next/next/no-img-element -- external, tiny, lazy: next/image would proxy someone's picture through our server.
        <img
          key={src}
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed((i) => i + 1)}
          className="absolute inset-0 h-full w-full rounded-full bg-muted object-cover"
        />
      )}
    </span>
  );
}

/** The post's author, as a picture. */
export function AuthorAvatar({
  target,
  size = 36,
  className,
}: {
  target: Pick<PlacementTargetRecord, "surface" | "author" | "community">;
  size?: number;
  className?: string;
}) {
  const data = authorAvatar(target);
  // A new author is a new picture to try: the failed count starts over.
  return <Avatar key={data.images.join(" ") || data.name} data={data} size={size} className={className} />;
}

/**
 * "Me": the business's favicon in a circle, or its initials when it has no
 * site on record.
 */
export function BusinessAvatar({ business, size = 36 }: { business: BusinessIdentity; size?: number }) {
  const me = businessAvatar(business);
  if (!me.domain) {
    return <Avatar data={{ handle: null, name: me.name, images: [], initials: me.initials, tone: me.tone, mark: null }} size={size} />;
  }
  return (
    <span
      aria-hidden="true"
      data-avatar="business"
      className="inline-flex shrink-0 items-center justify-center rounded-full border border-foreground/10 bg-background"
      style={{ width: size, height: size }}
    >
      <Favicon domain={me.domain} size={Math.round(size * 0.55)} />
    </span>
  );
}

/**
 * One side of the thread: the picture in a narrow column and what was said
 * beside it. With `line`, a thin line runs down from the picture to the
 * next side, so the post and the reply read as one thread.
 */
export function ThreadSide({ avatar, line = false, children }: { avatar: ReactNode; line?: boolean; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="flex w-9 shrink-0 flex-col items-center">
        {avatar}
        {line && <span aria-hidden="true" data-thread-line="" className="mt-1.5 w-0.5 flex-1 rounded-full bg-foreground/10" />}
      </div>
      <div className={cn("min-w-0 flex-1 space-y-3", line && "pb-4")}>{children}</div>
    </div>
  );
}

/** The author's name and, under it, the platform and how old the post is; `end` at the right (Close, Open post). */
export function PostHeader({
  target,
  now,
  end,
}: {
  target: Parameters<typeof postMeta>[0];
  now: number;
  end?: ReactNode;
}) {
  const { name } = authorAvatar(target);
  const meta = postMeta(target, now);
  return (
    <div className="-mb-2 flex min-h-9 items-center gap-2">
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate text-sm font-semibold">{name}</p>
        {meta && <p className="truncate text-xs text-muted-foreground">{meta}</p>}
      </div>
      {end}
    </div>
  );
}

/** The name beside the reply: the business's. */
export function ReplyHeader({ business, children }: { business: BusinessIdentity; children?: ReactNode }) {
  return (
    <div className="-mb-1.5 flex min-h-9 items-center gap-2">
      <p className="min-w-0 flex-1 truncate text-sm font-semibold leading-tight">
        {businessAvatar(business).name}
        {children && <span className="block truncate text-xs font-normal text-muted-foreground">{children}</span>}
      </p>
    </div>
  );
}

/** Closes the item open in the list, on a phone: at the right of the post's header, a thumb wide. */
export function CloseItem({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-expanded="true"
      aria-label="Close"
      className="-my-1 -mr-2 inline-flex h-11 w-11 shrink-0 items-center justify-center text-muted-foreground"
    >
      <ChevronUp className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}

/**
 * The post a post quotes, nested under it the way X shows it (2026-11-14):
 * a rounded box with the quoted author's picture (or initials), name,
 * handle and age, the quoted text in a few lines and its first photo as a
 * thumbnail. The whole box is one link to the quoted post on X, a thumb
 * tall at least. On @hank_ships's "Naming is the hardest part of shipping", the quoted
 * listing for "Pet Portrait AI" is the post's whole point.
 *
 * `label` names the relation when it is not a quote ("Replying to").
 */
export function QuotedPostBox({
  post,
  now,
  label,
}: {
  post: ReferencedPost & { text: string };
  now: number;
  label?: string;
}) {
  const [broken, setBroken] = useState(false);
  const avatar = authorAvatar({ surface: "x", author: post.handle, community: null });
  const handle = post.handle ? `@${post.handle}` : null;
  const name = post.authorName ?? handle ?? "Post on X";
  const age = ageLabel(post.postedAt, post.postedAtPrecision, now);
  const first = post.media.find((item) => imageUrlOf(item) !== null) ?? null;
  const thumb = first && !broken ? imageUrlOf(first) : null;
  const body = (
    <>
      {label && <span className="mb-1 block text-xs text-muted-foreground">{label}</span>}
      <span className="flex min-w-0 items-center gap-1.5 text-xs leading-tight">
        <Avatar key={avatar.images.join(" ") || avatar.name} data={avatar} size={20} />
        <span className="min-w-0 truncate">
          <span className="font-semibold text-foreground">{name}</span>
          {handle && post.authorName && <span className="text-muted-foreground"> {handle}</span>}
          {age && <span className="text-muted-foreground"> · {age}</span>}
        </span>
      </span>
      <span className="mt-1.5 flex gap-3">
        <span className="line-clamp-4 min-w-0 flex-1 whitespace-pre-wrap break-words text-sm text-foreground/90">
          {post.text || (first ? "" : "(no text)")}
        </span>
        {thumb && (
          // eslint-disable-next-line @next/next/no-img-element -- X's own image, lazy, no referrer: next/image would proxy someone's picture through our server.
          <img
            src={thumb}
            alt={first?.altText ?? "Image in the quoted post"}
            width={64}
            height={64}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setBroken(true)}
            className="h-16 w-16 shrink-0 rounded-md border border-foreground/10 bg-muted object-cover"
          />
        )}
      </span>
    </>
  );
  const box = "block min-h-11 w-full rounded-xl border border-border bg-card px-3 py-2.5 text-left";
  if (!post.url) return <div data-quoted-post="" className={box}>{body}</div>;
  return (
    <a
      href={post.url}
      target="_blank"
      rel="noopener noreferrer"
      data-quoted-post=""
      aria-label={`${label ?? "Quoted post"} by ${name}, open on X`}
      className={cn(box, "transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}
    >
      {body}
    </a>
  );
}

/**
 * What the post quotes and answers, under its text: the post it replies to
 * and the post it quotes, each as a nested box, and a quiet line when one
 * exists that could not be read (lib/placements/referenced.ts). Nothing for
 * a post that references none, or when it is not known.
 */
export function PostReferences({
  target,
  now,
}: {
  target: Pick<PlacementTargetRecord, "url" | "quotedPost" | "quoteUnread" | "repliedToPost" | "repliedToUnread">;
  now: number;
}) {
  const quoted = target.quotedPost;
  const repliedTo = target.repliedToPost;
  const unreadLine = referencedUnreadLine({
    quotedPost: quoted ?? null,
    quoteUnread: target.quoteUnread ?? null,
    repliedToUnread: target.repliedToUnread ?? null,
  });
  const readQuote = quoted && quoted.text !== null ? (quoted as ReferencedPost & { text: string }) : null;
  const readReply = repliedTo && repliedTo.text !== null ? (repliedTo as ReferencedPost & { text: string }) : null;
  if (!readQuote && !readReply && !unreadLine) return null;
  const unreadHref = target.quoteUnread ? (quoted?.url ?? target.url) : (repliedTo?.url ?? target.url);
  return (
    <div className="space-y-2">
      {readReply && <QuotedPostBox post={readReply} now={now} label="Replying to" />}
      {readQuote && <QuotedPostBox post={readQuote} now={now} />}
      {unreadLine && (
        <p className="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
          <span>{unreadLine} ·</span>
          <a
            href={unreadHref}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open it on X"
            className="inline-flex min-h-11 items-center underline underline-offset-2"
          >
            Open
          </a>
        </p>
      )}
    </div>
  );
}
