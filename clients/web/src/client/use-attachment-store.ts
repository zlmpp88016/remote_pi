/**
 * Inline image attachment state (plan/30 allows ONE pending image per message).
 *
 * Held in the WIRE shape (`data` base64 + `mime`) rather than a browser
 * `File`/blob URL: the preview and the send path must use the exact bytes that
 * will travel, so nothing is re-encoded between picking and sending.
 */

import { useState } from "react";

import type { WireImage } from "@/lib/remote-pi/protocol";

export interface AttachmentState {
  readonly attachment: WireImage | null;
  readonly error: string | null;
}

export interface AttachmentActions {
  readonly setAttachment: (attachment: WireImage | null) => void;
  readonly setError: (error: string | null) => void;
}

export interface AttachmentStore {
  readonly state: AttachmentState;
  readonly actions: AttachmentActions;
}

export function useAttachmentStore(): AttachmentStore {
  const [attachment, setAttachment] = useState<WireImage | null>(null);
  const [error, setError] = useState<string | null>(null);

  return {
    state: { attachment, error },
    actions: { setAttachment, setError },
  };
}
