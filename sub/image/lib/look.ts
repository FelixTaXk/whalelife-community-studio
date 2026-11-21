/*! 画画 · 外观、场景与「拍照/画画」的提示词拼装。
 *
 * 这里不再写死任何角色。外貌、默认衣服、标志性道具、默认场景和画者说明
 * 全部来自 studio 配置的 persona 段；没配置就按通用人物和通用场景出图。
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */

/** 从配置传进来的人设外观；所有字段都可空。 */
export type PersonaLook = {
  appearance?: string;
  defaultOutfit?: string;
  prop?: string;
  painterStyle?: string;
  paintFallbackSubject?: string;
  selfieFallbackScene?: string;
  snapshotFallbackScene?: string;
};

const GENERIC_APPEARANCE = 'a young adult with a natural, ordinary everyday appearance';
const GENERIC_OUTFIT = 'casual everyday clothes';
const GENERIC_SELFIE_SCENE = 'by the window';
const GENERIC_SNAPSHOT_SCENE = 'a quiet corner by the window';
const GENERIC_PAINT_SUBJECT = 'the street outside the window after rain';
const GENERIC_PAINTER = 'painted by an amateur artist who is good at catching light and shadow but not a professional';

const CAMERA_SELFIE =
  'selfie taken by the subject, phone held at arm\'s length, front camera, close-up of head and shoulders, ' +
  'slightly tilted, natural window light, casual candid snapshot, fine film grain, realistic photography, ' +
  'sharp focus on the eyes';

const CAMERA_FILM =
  '35mm film photograph, natural available light, shallow depth of field, muted slightly warm colors, ' +
  'everyday unposed moment, visible grain, soft vignetting';
const CAMERA_PHOTO =
  'smartphone photo, natural available light, true-to-life colors, casual everyday snapshot, ' +
  'sharp focus, slight handheld imperfection';

const NEGATIVE_PHOTO =
  'anime, 3d render, doll-like, plastic skin, airbrushed, deformed hands, extra fingers, ' +
  'text, watermark, signature, low quality, blurry';
const NEGATIVE_SELFIE = `${NEGATIVE_PHOTO}, full body, full-length portrait, wide shot`;
const NEGATIVE_SNAPSHOT = `${NEGATIVE_PHOTO}, people, person, crowd, hands`;
const NEGATIVE_PAINT = 'photo, photorealistic, 3d render, text, watermark, signature, low quality, messy lines';

export type ShootKind = 'selfie' | 'snapshot' | 'paint';

export type ShootOptions = {
  scene?: string;
  mood?: string;
  outfit?: string;
  style?: string;
  subject?: string;
  persona?: PersonaLook;
};

const clean = (value?: string) => String(value ?? '').trim().replace(/[,\s]+$/g, '');

const lookOf = (persona?: PersonaLook, outfit?: string) => {
  const appearance = clean(persona?.appearance) || GENERIC_APPEARANCE;
  const dress = clean(outfit) || clean(persona?.defaultOutfit) || GENERIC_OUTFIT;
  const prop = clean(persona?.prop);
  return prop ? `${appearance}, wearing ${dress}, with ${prop}` : `${appearance}, wearing ${dress}`;
};

/** 自拍：主体拿着手机自己拍。style=photo 默认，film 偏胶片。 */
export function selfiePrompt(options: ShootOptions = {}): { prompt: string; negative: string } {
  const scene = clean(options.scene) || clean(options.persona?.selfieFallbackScene) || GENERIC_SELFIE_SCENE;
  const mood = clean(options.mood);
  const style = String(options.style ?? 'photo').toLowerCase();
  const place = scene ? `, ${scene}` : '';
  const look = lookOf(options.persona, options.outfit);
  const face = mood ? `, ${mood}` : '';
  const night = /late at night|night|dark|evening/.test(scene);
  const camera = night
    ? CAMERA_SELFIE.replace('natural window light', 'dim warm lamp light, dark room, soft phone-screen glow')
    : CAMERA_SELFIE;
  if (style === 'film') {
    return {
      prompt: `${look}, ${camera}${place}${face}, ${CAMERA_FILM}`,
      negative: NEGATIVE_SELFIE,
    };
  }
  return { prompt: `${look}, ${camera}${place}${face}`, negative: NEGATIVE_SELFIE };
}

/** 随手拍：没人入镜的角落、光、东西。 */
export function snapshotPrompt(options: ShootOptions = {}): { prompt: string; negative: string } {
  const scene = clean(options.scene) || clean(options.persona?.snapshotFallbackScene) || GENERIC_SNAPSHOT_SCENE;
  const mood = clean(options.mood);
  const style = String(options.style ?? 'film').toLowerCase();
  const detail = mood ? `, ${mood}` : ', the light is doing most of the work';
  return {
    prompt: `${scene}${detail}, no people, ${style === 'photo' ? CAMERA_PHOTO : CAMERA_FILM}`,
    negative: NEGATIVE_SNAPSHOT,
  };
}

/** 「画一幅」：速写/水彩/插画，抓光，不追求照片。 */
export function paintPrompt(options: ShootOptions = {}): { prompt: string; negative: string } {
  const subject =
    clean(options.subject) || clean(options.scene) || clean(options.persona?.paintFallbackSubject) || GENERIC_PAINT_SUBJECT;
  const mood = clean(options.mood);
  const style = normalizePaintingStyle(options.style);
  const lead =
    style === 'sketch'
      ? 'loose pencil and ink sketch of'
      : style === 'illustration'
        ? 'flat-color storybook illustration of'
        : 'loose watercolor and ink sketch of';
  const painter = clean(options.persona?.painterStyle) || GENERIC_PAINTER;
  const tail =
    style === 'sketch'
      ? 'quick confident lines, visible construction, uneven shading, rough paper texture, muted palette'
      : style === 'illustration'
        ? 'clean shapes, limited warm palette, soft grain, hand-drawn texture, simple background'
        : `${painter}, uneven washes, visible pencil underdrawing, rough paper texture, warm muted palette`;
  return {
    prompt: `${lead} ${subject}${mood ? `, ${mood}` : ''}, ${tail}`,
    negative: NEGATIVE_PAINT,
  };
}

/** 自画像：画出来的人，保留配置外观，但不带自拍机位、不接日程和衣柜。 */
export function selfPortraitPrompt(options: ShootOptions = {}): { prompt: string; negative: string } {
  return paintPrompt({
    subject: lookOf(options.persona),
    mood: options.mood,
    style: options.style,
    persona: options.persona,
  });
}

export function normalizePaintingStyle(value?: string): 'watercolor' | 'sketch' | 'illustration' {
  const style = String(value ?? '').toLowerCase();
  if (style === 'sketch' || style === 'line' || style === 'pencil') return 'sketch';
  if (style === 'illustration' || style === 'storybook' || style === 'flat') return 'illustration';
  return 'watercolor';
}

/** 各个动作的默认画幅（竖构图给人像，横构图给场景）。 */
export const SIZE_FOR: Record<ShootKind, { width: number; height: number }> = {
  selfie: { width: 512, height: 896 },
  snapshot: { width: 1024, height: 768 },
  paint: { width: 896, height: 640 },
};
