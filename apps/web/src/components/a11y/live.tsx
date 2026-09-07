// Screen-reader live announcements (WP2). One visually-hidden polite region is
// mounted by the app shell; `announce()` can be called from anywhere.
import { useEffect, useState } from "react";
import { subscribeLiveAnnouncements } from "./announce.ts";

export { announce } from "./announce.ts";

export function LiveRegion() {
  const [text, setText] = useState("");
  useEffect(() => subscribeLiveAnnouncements(setText), []);
  return (
    <div aria-live="polite" role="status" className="sr-only">
      {text}
    </div>
  );
}
