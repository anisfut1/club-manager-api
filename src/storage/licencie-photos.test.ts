import { describe, expect, it } from "vitest";
import { storedPhotoPath } from "./licencie-photos.js";

describe("storedPhotoPath", () => {
  const base = "https://x.supabase.co/storage/v1/object/public/licencie-photos";

  it("reconnaît une photo stockée par l'API pour CE club", () => {
    expect(storedPhotoPath(`${base}/club-a/lic-1/abc.webp`, "club-a")).toBe("club-a/lic-1/abc.webp");
  });

  it("ne touche jamais une URL externe ni la photo d'un autre club", () => {
    expect(storedPhotoPath("https://exemple.fr/photo.jpg", "club-a")).toBeNull();
    expect(storedPhotoPath(`${base}/club-b/lic-1/abc.webp`, "club-a")).toBeNull();
    expect(storedPhotoPath(null, "club-a")).toBeNull();
  });
});
