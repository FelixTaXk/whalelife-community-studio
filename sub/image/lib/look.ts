/*! 画画 · 人设外观与「她拍的东西」的提示词拼装。
 *
 * 自拍、随手拍都从这里出提示词，保证每张都是同一个人、同一种拍法：
 * 外貌来自 memory/personas/whale.md（周小迟），这里只做英文转写，不加任何形象之外的内容。
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */

/** 她的固定外观。服装、发型会按当天设定微调，但脸、发色、身高、随身那台旧胶片机不变。 */
export const LOOK_BASE =
  'a 17-year-old Chinese high-school girl, about 160cm, slim and ordinary teenage build, ' +
  'cute round face, long straight black hair reaching past her waist, ' +
  'eye corners that turn down slightly when she smiles, no makeup';
export const UNIFORM =
  'wearing a school uniform jacket with a small blue paint stain on the cuff, ' +
  'white sneakers with two little hand-drawn birds on the edge, ' +
  'an old film camera hanging from a worn leather strap around her neck';
export const LOOK = `${LOOK_BASE}, ${UNIFORM}`;

/** 自拍/照片里，衣柜给了衣服就整段替换校服，避免两套衣服同时出现。 */
const lookWithOutfit = (outfit?: string) => {
  const value = clean(outfit);
  return value ? `${LOOK_BASE}, wearing ${value}, an old film camera hanging from a worn leather strap around her neck` : LOOK;
};

const CAMERA_SELFIE =
  'selfie taken by herself, phone held at arm\'s length, front camera, close-up of head and shoulders, ' +
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

const NEGATIVE_PAINT = 'photo, photorealistic, 3d render, text, watermark, signature, low quality, messy lines';

export type ShootKind = 'selfie' | 'snapshot' | 'paint';

export type ShootOptions = {
  scene?: string;
  mood?: string;
  outfit?: string;
  style?: string;
  subject?: string;
};

const clean = (value?: string) => String(value ?? '').trim().replace(/[,\s]+$/g, '');

/** 自拍：她拿着手机/相机自己拍。style=photo 默认，film 偏胶片，paint 是画出来的她。 */
export function selfiePrompt(options: ShootOptions = {}): { prompt: string; negative: string } {
  const scene = clean(options.scene);
  const mood = clean(options.mood);
  const outfit = clean(options.outfit);
  const style = String(options.style ?? 'photo').toLowerCase();
  const place = scene ? `, ${scene}` : ', in her room by the window';
  const look = lookWithOutfit(outfit);
  const face = mood ? `, ${mood}` : '';
  if (style === 'paint') {
    return {
      prompt: `loose watercolor painting of ${look}, painted from life, ${CAMERA_SELFIE.replace('realistic photography', 'watercolor on rough paper')}${place}${face}`,
      negative: NEGATIVE_PAINT,
    };
  }
  if (style === 'film') {
    return {
      prompt: `${look}, ${CAMERA_SELFIE}${place}${face}, ${CAMERA_FILM}`,
      negative: NEGATIVE_SELFIE,
    };
  }
  return { prompt: `${look}, ${CAMERA_SELFIE}${place}${face}`, negative: NEGATIVE_SELFIE };
}

/** 随手拍：没人入镜的角落、光、东西。她拍这类比拍人熟。 */
export function snapshotPrompt(options: ShootOptions = {}): { prompt: string; negative: string } {
  const scene = clean(options.scene) || 'a corner of her room, drying laundry on the balcony';
  const mood = clean(options.mood);
  const style = String(options.style ?? 'film').toLowerCase();
  const detail = mood ? `, ${mood}` : ', the light is doing most of the work';
  if (style === 'paint') {
    return {
      prompt: `quick watercolor sketch of ${scene}${detail}, loose brush strokes, paper texture, light and shadow only`,
      negative: NEGATIVE_PAINT,
    };
  }
  return {
    prompt: `${scene}${detail}, no people, ${style === 'photo' ? CAMERA_PHOTO : CAMERA_FILM}`,
    negative: NEGATIVE_PHOTO,
  };
}

/** 「画一幅」：她真的会画，但不算精 —— 速写/水彩/插画，抓光。 */
export function paintPrompt(options: ShootOptions = {}): { prompt: string; negative: string } {
  const subject = clean(options.subject) || clean(options.scene) || 'the street outside her window after rain';
  const mood = clean(options.mood);
  const style = normalizePaintingStyle(options.style);
  const lead =
    style === 'sketch'
      ? 'loose pencil and ink sketch of'
      : style === 'illustration'
        ? 'flat-color storybook illustration of'
        : 'loose watercolor and ink sketch of';
  const tail =
    style === 'sketch'
      ? 'quick confident lines, visible construction, uneven shading, rough paper texture, muted palette'
      : style === 'illustration'
        ? 'clean shapes, limited warm palette, soft grain, hand-drawn texture, simple background'
        : 'painted by a high-school girl who is good at catching light and shadow but not a professional, uneven washes, visible pencil underdrawing, rough paper texture, warm muted palette';
  return {
    prompt: `${lead} ${subject}${mood ? `, ${mood}` : ''}, ${tail}`,
    negative: NEGATIVE_PAINT,
  };
}

/** 自画像：画出来的她，保留固定外观，但不带自拍机位、不接日程和衣柜。 */
export function selfPortraitPrompt(options: ShootOptions = {}): { prompt: string; negative: string } {
  const mood = clean(options.mood);
  return paintPrompt({ subject: LOOK, mood, style: options.style });
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
