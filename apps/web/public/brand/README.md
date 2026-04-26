# Brand PNG assets required in production

These files must exist in this folder so Vite copies them into `dist/brand` and the app can load the new 3D logo in production:

- `apps/web/public/brand/demetra-logo-dark.png`
- `apps/web/public/brand/demetra-logo-light.png`

If these files are missing, `BrandLogo` will try to load PNG paths that do not exist and the image will not render.
