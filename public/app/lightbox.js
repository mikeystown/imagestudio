// Full-size in-app image viewer. The image fills the screen (scaled up if needed); clicking it zooms to
// actual pixels or 2x the fitted size, whichever is larger, and scrolling pans. Esc or the backdrop closes.

import { $, imgSrc } from "./util.js";

const box = $("lightbox");
const img = $("lbImg");
let zoomed = false;

export const lightboxOpen = () => !box.classList.contains("hidden");

const fitScale = () => Math.min(innerWidth / img.naturalWidth, innerHeight / img.naturalHeight);

function layout(e) {
  if (!img.naturalWidth) return;
  const fit = fitScale();
  const scale = zoomed ? Math.max(1, fit * 2) : fit;
  const before = e && { fx: e.offsetX / img.clientWidth, fy: e.offsetY / img.clientHeight };
  img.style.width = `${Math.floor(img.naturalWidth * scale)}px`;
  img.style.height = `${Math.floor(img.naturalHeight * scale)}px`;
  box.classList.toggle("zoomed", zoomed);
  // Keep the clicked point under the cursor after zooming in.
  if (before) {
    box.scrollLeft = before.fx * img.offsetWidth - e.clientX;
    box.scrollTop = before.fy * img.offsetHeight - e.clientY;
  }
}

// Show `file`; if already open, swap the image and reset to fit.
export function openLightbox(file, caption = "") {
  const src = imgSrc(file);
  zoomed = false;
  if (img.getAttribute("src") !== src) {
    img.style.width = img.style.height = "";
    img.src = src;
  }
  $("lbCaption").textContent = caption;
  box.classList.remove("hidden");
  layout();
}

// Refresh caption/image only while open (e.g. when Rate moves to another image).
export function updateLightbox(file, caption) {
  if (!lightboxOpen()) return;
  if (img.getAttribute("src") !== imgSrc(file)) openLightbox(file, caption);
  else $("lbCaption").textContent = caption;
}

export function closeLightbox() {
  box.classList.add("hidden");
}

img.addEventListener("load", () => layout());
addEventListener("resize", () => lightboxOpen() && layout());
img.addEventListener("click", (e) => {
  e.stopPropagation();
  zoomed = !zoomed;
  layout(zoomed ? e : undefined);
});
box.addEventListener("click", closeLightbox);
$("lbClose").addEventListener("click", closeLightbox);

// Capture phase so Esc closes the viewer before any tab's own key handling sees it.
document.addEventListener("keydown", (e) => {
  if (lightboxOpen() && e.key === "Escape") {
    e.stopImmediatePropagation();
    e.preventDefault();
    closeLightbox();
  }
}, true);
