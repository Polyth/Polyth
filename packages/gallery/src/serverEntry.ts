// Gallery server package: one read-only route that lists the image files of a
// project folder. It reads through the files package's FileService so root
// confinement, worktree resolution, and the project jail stay owned by that
// package instead of being re-implemented here.
import {
  localOnlyRemoteAccess,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { galleryRoutes, type GalleryFileService } from "./routes.ts";

export { galleryRoutes, listGalleryImages } from "./routes.ts";
export type { GalleryFileEntry, GalleryFileService, GalleryRoutesDeps, ListGalleryInput } from "./routes.ts";

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  let routes: ReturnType<typeof galleryRoutes> | null = null;
  return {
    // The route only enumerates project files and is meaningful to the local
    // operator's own projects; paired-device access stays default-deny.
    remoteAccess: localOnlyRemoteAccess(["gallery"]),
    routes: async (rc) => (routes ? routes(rc) : false),
    onEnable() {
      routes = async (rc) => {
        if (!rc.path.startsWith("/api/gallery/")) return false;
        const files = host.services.get(serverServiceKey<GalleryFileService>("files"));
        if (!files) {
          rc.json(503, { error: "unavailable", message: "the files package is not enabled" });
          return true;
        }
        const scoped = host.forSpace(rc.space);
        return galleryRoutes({ files, projects: scoped.projects, sessions: scoped.sessions })(rc);
      };
    },
    onDisable() {
      routes = null;
    },
  };
}
