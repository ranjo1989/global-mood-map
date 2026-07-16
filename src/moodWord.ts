/**
 * Map a global mean valence (-1..1) to the "emotional weather" word +
 * emoji shown in the topbar chip and drawn onto share snapshot cards.
 */
export function moodWord(v: number): { word: string; emoji: string } {
  if (v >= 0.3) return { word: 'Sunny', emoji: '😊' };
  if (v >= 0.1) return { word: 'Fair', emoji: '🙂' };
  if (v > -0.1) return { word: 'Mixed', emoji: '😐' };
  if (v > -0.3) return { word: 'Overcast', emoji: '😕' };
  return { word: 'Stormy', emoji: '😰' };
}
