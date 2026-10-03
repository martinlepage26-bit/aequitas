# Landing page design

The locale landing pages use Aequitas's existing slate-blue palette and
serif/sans typography from `src/ui/tokens.ts`. The layout gives the existing
sign-in, case-list, and language-switch actions a clear visual hierarchy.
The original description of the process and consent is retained verbatim.

The landing page uses a scoped CSS module, server-rendered content, a local
optimized image, and no new runtime dependencies. Its theme follows the
system preference. Interactive targets are at least 44px, focus remains
visible, and hover feedback respects reduced motion.

Design direction: a calm, accessible entry page for people managing a
dispute. Design variance 4, motion intensity 2, visual density 4. The
existing page had a narrow text block, no navigation hierarchy, and no
visual asset; the routes and bilingual copy were worth preserving.

## Anti-Numbing brief

Verdict: pass.

1. Idea: make entry to a shared dispute record clearer and easier to read.
2. Negligence map: people under stress may defer to an apparent authority;
   a prominent sign-in action invites fast entry. Automatic-resolution
   interfaces can turn that same habit into unexamined acceptance.
3. Harvest risk: an attractive page could imply that a generated proposal
   is a decision the parties should simply accept.
4. Reverse hinge: the visible process connects easy entry with presenting
   evidence, human review, and an explicit choice about consent.
5. Dual-use test: low effort brings a party into the record; the same entry
   path makes the record and each party's decision easier to attend to.
6. Minimal awakening: open a case record or sign in, then identify the
   evidence and the next decision belonging to the party.
7. Keep the human review and consent wording alongside the visual design.

## Image provenance

The built-in image-generation tool produced the decorative photograph.
The selected PNG was converted to a 140,206-byte WebP at
`public/images/shared-record.webp`. It has empty alternative text because
the adjoining copy explains the concept without depending on the image.

Final generation prompt:

> Use case: photorealistic-natural. Asset type: a portrait 4:5 hero photograph for Aequitas, a calm Canadian bilingual dispute-resolution website. Primary request: create a beautifully composed high-end editorial still-life about two perspectives sharing one record. Scene: a quiet daylit modern workspace, pale stone table. Subject: two open slate-blue document folders arranged opposite each other on a rounded pale stone table, their neatly ordered white pages meeting near the middle, a single steel pen, softly lit architectural window shadows. Photorealistic paper fibers, tactile cloth-covered blue folders, cool natural side light, restrained elegant composition with strong negative space, close oblique overhead angle. Palette: deep slate blue #2F4A6B, off-white #FAF9F7, gentle stone grey. Art direction: believable sophisticated photographic image, precise grounded objects, balanced asymmetric crop, crisp details, real shadows, no beige haze. Portrait orientation, suitable for a website image on the right of hero copy. Constraints: absolutely no legible text or logos on documents, no people or hands, no gavels, no scales of justice, no screens, no charts, no watermarks, no image labels. This is a decorative photograph, not a screenshot or product mockup.
