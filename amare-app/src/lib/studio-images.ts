const SITE_IMAGES = "https://www.amarewellness.com/images";

/** Reformer + Mat equipment imagery (First visit, etc.). */
export const STUDIO_CLASS_IMAGES = [
  { name: "Reformer", src: `${SITE_IMAGES}/section-our-classes/reformersquare.webp` },
  { name: "Mat", src: `${SITE_IMAGES}/section-our-classes/matsquare.webp` },
] as const;

/** Signed-out home + login email step carousel (remote production assets). */
export const HOME_CAROUSEL_SLIDES = [
  ...STUDIO_CLASS_IMAGES,
  {
    name: "Explore AMARÉ",
    subtitle: "Discover classes, memberships, and studio updates.",
    src: `${SITE_IMAGES}/home-explore/instagram.webp`,
  },
] as const;

export type HomeCarouselSlide = (typeof HOME_CAROUSEL_SLIDES)[number];
