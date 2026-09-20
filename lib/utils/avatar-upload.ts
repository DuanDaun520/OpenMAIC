/**
 * Client-side avatar upload pipeline — shared by every avatar-editing surface
 * (the profile card and the home GreetingBar).
 *
 * A custom avatar is center-cropped and resized on a canvas to a 128×128
 * JPEG (quality 0.85): a few KB of data-URL, the exact shape the account
 * profile endpoint accepts for `user_accounts.avatar_url`. The 5 MB /
 * `image/*` gate mirrors the pre-extraction duplicated implementations.
 */

export type AvatarUploadRejection = 'too-large' | 'not-image';

const MAX_AVATAR_SIZE = 5 * 1024 * 1024; // 5 MB

export function resizeAvatarToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_AVATAR_SIZE) {
      reject('too-large' satisfies AvatarUploadRejection);
      return;
    }
    if (!file.type.startsWith('image/')) {
      reject('not-image' satisfies AvatarUploadRejection);
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => reject('not-image' satisfies AvatarUploadRejection);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject('not-image' satisfies AvatarUploadRejection);
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject('not-image' satisfies AvatarUploadRejection);
          return;
        }
        const scale = Math.max(128 / img.width, 128 / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (128 - w) / 2, (128 - h) / 2, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}
