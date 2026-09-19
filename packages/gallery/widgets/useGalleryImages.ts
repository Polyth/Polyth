import { useEffect, useState } from "react";
import type { GalleryListing } from "../src/shared.ts";
import { fetchGalleryListing } from "./galleryApi.ts";

export interface GalleryImagesState {
  listing: GalleryListing | null;
  loading: boolean;
  error: string;
}

const IDLE: GalleryImagesState = { listing: null, loading: false, error: "" };

export function useGalleryImages(
  projectId: string | null,
  sessionId: string | null,
  folder: string,
  recursive: boolean,
  reloadToken: number,
): GalleryImagesState {
  const [state, setState] = useState<GalleryImagesState>(IDLE);

  useEffect(() => {
    if (!projectId) {
      setState(IDLE);
      return;
    }
    const controller = new AbortController();
    let current = true;
    setState((previous) => ({ ...previous, loading: true, error: "" }));
    fetchGalleryListing({ projectId, sessionId, folder, recursive, signal: controller.signal })
      .then((listing) => {
        if (current) setState({ listing, loading: false, error: "" });
      })
      .catch((error: unknown) => {
        if (!current || controller.signal.aborted) return;
        setState({ listing: null, loading: false, error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [projectId, sessionId, folder, recursive, reloadToken]);

  return state;
}
