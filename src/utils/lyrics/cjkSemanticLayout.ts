import type { Line, Word } from '../../types';
import { hasWordSegmentationOverride, segmentLyricWords } from './wordSegmentation';

// src/utils/lyrics/cjkSemanticLayout.ts
// Builds parser-preserving lyric layout units for visualizer display planning.
//
// This file runs after lyrics have already been parsed into Line.words.
// It must not rewrite the Line object or collapse parser words globally, because YRC/QRC/enhanced-LRC
// can intentionally expose tiny timed fragments such as:
//
//   Line.words: ["It", "’", "s", "unbelievable"]
//
// Visualizers often need a more readable display shape than those raw timed fragments. Layout units are
// that display-planning layer: they can group fragments for row splitting and rendering while still keeping
// every original Word inside `words` for timing.
//
// Example with sticky punctuation:
//
//   input words:  It | ’ | s | unbelievable
//   layoutUnits: It’s(isSticky, words=[It, ’, s]) | unbelievable
//
// Example with CJK semantic grouping:
//
//   input words:  世 | 界 | 。
//   layoutUnits: 世界。(isSemantic, isSticky, words=[世, 界, 。])
//
// Display words are derived later. Sticky non-semantic units render as one visual word; semantic CJK units
// still return their original words so per-character timing stays intact.

export interface LyricLayoutUnit {
    // Text used for layout planning. This can differ from the raw parser token when semantic or sticky grouping is applied.
    text: string;
    // Original parser words contained in this layout unit. Their timing is preserved and remains the source of truth.
    words: Word[];
    // Start/end span of the contained parser words.
    startTime: number;
    endTime: number;
    // True when Intl.Segmenter grouped CJK parser words into a semantic layout unit.
    isSemantic: boolean;
    // True when punctuation/contraction fragments have been attached for visual layout stability.
    isSticky?: boolean;
}

/**
 * The Line fields layout planning reads. `wordSegments` carries the user's saved split,
 * `autoWordSegments` icu-folia's default one.
 */
export type SegmentableLine = Pick<Line, 'fullText' | 'words' | 'wordSegments' | 'autoWordSegments'>
    & Partial<Pick<Line, 'startTime' | 'endTime'>>;

export interface BuildPostLyricLayoutUnitsOptions {
    // Enables CJK semantic grouping before sticky punctuation is applied.
    semantic?: boolean;
    // Enables language-agnostic punctuation/contraction attachment.
    sticky?: boolean;
}

interface WordSegment {
    segment: string;
    isWordLike?: boolean;
}

const CJK_REGEX = /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/;
const WHITESPACE_REGEX = /^\s+$/;
const APOSTROPHE_ONLY_REGEX = /^['’]\s*$/;
const CONTRACTION_SUFFIX_REGEX = /^(s|t|m|d|ll|re|ve|em)\s*$/i;
const DIRECT_CONTRACTION_REGEX = /^['’](s|t|m|d|ll|re|ve|em)\s*$/i;
const TRAILING_APOSTROPHE_REGEX = /['’]\s*$/;
const TRAILING_WORD_CHAR_REGEX = /[\p{L}\p{N}]$/u;
const INLINE_CONTRACTION_REGEX = /[\p{L}\p{N}]+['’](s|t|m|d|ll|re|ve|em)/iu;
const STICKY_TRAILING_PUNCTUATION_REGEX = /^[,.;:!?，。！？、：；）】》」』〉〕］)}\]"'’”’]+$/u;

const hasCjkText = (text: string) => CJK_REGEX.test(text);

const FALLBACK_CJK_PROBE = /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/;

/**
 * 兜底词表：歌词源只给了行级时间轴时 words 会是空的（parserCore 的 simpleEntry 分支就是
 * `words: []`），这时整行一个字都渲染不出来。按 fullText 现切一份顶上。
 * 切法与 parserCore 的 buildTimedWords 对齐 —— 含 CJK 的片段逐字，其余按空白 —— 但用
 * Array.from 切，代理对（扩展汉字、emoji）不会被劈成两半。
 */
const buildFallbackWords = (line: SegmentableLine): Word[] => {
    const text = line.fullText?.trim();
    if (!text) {
        return [];
    }
    const tokens: string[] = [];
    for (const raw of text.split(/\s+/).filter(Boolean)) {
        if (FALLBACK_CJK_PROBE.test(raw)) {
            tokens.push(...Array.from(raw));
        } else {
            tokens.push(raw);
        }
    }
    if (tokens.length === 0) {
        return [];
    }
    const start = line.startTime ?? 0;
    const end = Math.max(line.endTime ?? start + 1, start + 0.1);
    const step = (end - start) / tokens.length;
    return tokens.map((token, index) => ({
        text: token,
        startTime: start + step * index,
        endTime: start + step * (index + 1),
    }));
};

export const createSingleWordLayoutUnits = (words: Word[]): LyricLayoutUnit[] => words.map(word => ({
    text: word.text,
    words: [word],
    startTime: word.startTime,
    endTime: word.endTime,
    isSemantic: false,
}));

// Delegates to the one word segmenter in the codebase, which also honours the user's saved
// segmentation for this line. Only the two fields this file aligns on are kept.
const getWordSegments = (line: SegmentableLine): WordSegment[] | null => {
    const segments = segmentLyricWords(line);
    return segments.length > 0
        ? segments.map(({ segment, isWordLike }) => ({ segment, isWordLike }))
        : null;
};

const appendWordsToUnit = (unit: LyricLayoutUnit, text: string, words: Word[]) => {
    unit.text += text;
    unit.words.push(...words);
    unit.endTime = words[words.length - 1]?.endTime ?? unit.endTime;
};

const cloneUnit = (unit: LyricLayoutUnit): LyricLayoutUnit => ({
    ...unit,
    words: [...unit.words],
});

const appendUnitToStickyUnit = (target: LyricLayoutUnit, unit: LyricLayoutUnit) => {
    target.text += unit.text;
    target.words.push(...unit.words);
    target.endTime = unit.endTime;
    target.isSticky = true;
};

const canAttachToPrevious = (text: string) => TRAILING_WORD_CHAR_REGEX.test(text.trimEnd());

const endsWithApostrophe = (text: string) => TRAILING_APOSTROPHE_REGEX.test(text.trimEnd());

const isApostropheOnlyUnit = (unit: LyricLayoutUnit) => APOSTROPHE_ONLY_REGEX.test(unit.text.trim());

const isContractionSuffixUnit = (unit: LyricLayoutUnit) => CONTRACTION_SUFFIX_REGEX.test(unit.text.trim());

const isDirectContractionUnit = (unit: LyricLayoutUnit) => DIRECT_CONTRACTION_REGEX.test(unit.text.trim());

const isStickyTrailingPunctuationUnit = (unit: LyricLayoutUnit) => STICKY_TRAILING_PUNCTUATION_REGEX.test(unit.text.trim());

const hasAttachedTrailingPunctuation = (unit: LyricLayoutUnit) => {
    if (unit.words.length <= 1) {
        return false;
    }

    const lastWord = unit.words[unit.words.length - 1];
    return Boolean(lastWord && isStickyTrailingPunctuationUnit({
        text: lastWord.text,
        words: [lastWord],
        startTime: lastWord.startTime,
        endTime: lastWord.endTime,
        isSemantic: false,
    }));
};

const hasInlineContraction = (unit: LyricLayoutUnit) => (
    unit.words.length > 1
    && !unit.isSemantic
    && INLINE_CONTRACTION_REGEX.test(unit.text)
);

// Maps Intl.Segmenter output back onto parser words.
// If any segment cannot be aligned exactly, callers fall back to one-word units instead of guessing.
const mapSegmentsToWords = (segments: WordSegment[], words: Word[]): LyricLayoutUnit[] | null => {
    const units: LyricLayoutUnit[] = [];
    let wordIndex = 0;

    for (const segment of segments) {
        const segmentText = segment.segment;
        if (!segmentText || WHITESPACE_REGEX.test(segmentText)) {
            continue;
        }

        const startWordIndex = wordIndex;
        let collectedText = '';

        while (wordIndex < words.length && collectedText.length < segmentText.length) {
            collectedText += words[wordIndex].text;
            wordIndex += 1;

            if (!segmentText.startsWith(collectedText)) {
                return null;
            }
        }

        if (collectedText !== segmentText) {
            return null;
        }

        const segmentWords = words.slice(startWordIndex, wordIndex);
        const firstWord = segmentWords[0];
        const lastWord = segmentWords[segmentWords.length - 1];
        if (!firstWord || !lastWord) {
            return null;
        }

        if (!segment.isWordLike && units.length > 0) {
            appendWordsToUnit(units[units.length - 1], segmentText, segmentWords);
            continue;
        }

        units.push({
            text: segmentText,
            words: segmentWords,
            startTime: firstWord.startTime,
            endTime: lastWord.endTime,
            isSemantic: Boolean(segment.isWordLike && hasCjkText(segmentText) && segmentWords.length > 1),
        });
    }

    if (wordIndex !== words.length || units.length === 0) {
        return null;
    }

    return units;
};

// Legacy-compatible helper: only performs CJK semantic grouping.
// It does not apply sticky punctuation, so existing callers can keep the old behavior.
export const buildCjkSemanticLayoutUnits = (
    line: SegmentableLine
): LyricLayoutUnit[] => {
    if (line.words.length === 0) {
        // 空词表 = 整行画不出来，用 fullText 兜底，别再返回空数组。
        return createSingleWordLayoutUnits(buildFallbackWords(line));
    }

    const fallbackUnits = createSingleWordLayoutUnits(line.words);
    // The CJK gate exists because Intl.Segmenter only adds information over parser words for
    // scripts without spaces. A user-supplied split is deliberate in any script, so it skips it.
    if (!hasCjkText(line.fullText) && !hasWordSegmentationOverride(line)) {
        return fallbackUnits;
    }

    const segments = getWordSegments(line);
    if (!segments) {
        return fallbackUnits;
    }

    return mapSegmentsToWords(segments, line.words) ?? fallbackUnits;
};

// Attaches punctuation-like layout units to the previous unit before a visualizer splits rows/chunks.
// This prevents source fragments such as `It`, `’`, `s` from being placed in separate visual layers.
export const applyStickyPunctuationLayoutUnits = (units: LyricLayoutUnit[]): LyricLayoutUnit[] => {
    const merged: LyricLayoutUnit[] = [];

    for (let index = 0; index < units.length; index += 1) {
        const current = units[index];
        const previous = merged[merged.length - 1];
        if (!previous) {
            merged.push(cloneUnit(current));
            continue;
        }

        const next = units[index + 1];
        if (
            isApostropheOnlyUnit(current)
            && next
            && canAttachToPrevious(previous.text)
            && isContractionSuffixUnit(next)
        ) {
            appendUnitToStickyUnit(previous, current);
            appendUnitToStickyUnit(previous, next);
            index += 1;
            continue;
        }

        if (isDirectContractionUnit(current) && canAttachToPrevious(previous.text)) {
            appendUnitToStickyUnit(previous, current);
            continue;
        }

        if (isContractionSuffixUnit(current) && endsWithApostrophe(previous.text)) {
            appendUnitToStickyUnit(previous, current);
            continue;
        }

        if (isStickyTrailingPunctuationUnit(current) && canAttachToPrevious(previous.text)) {
            appendUnitToStickyUnit(previous, current);
            continue;
        }

        merged.push(cloneUnit(current));
    }

    return merged.map(unit => (
        hasAttachedTrailingPunctuation(unit) || hasInlineContraction(unit)
            ? { ...unit, isSticky: true }
            : unit
    ));
};

// Main post-parser entry point for visualizer layout preparation.
// Order is intentional: semantic grouping first, sticky punctuation second.
//
// Examples:
//
//   buildPostLyricLayoutUnits(line, { semantic: false, sticky: false })
//   -> one layout unit per parser word
//
//   buildPostLyricLayoutUnits(line, { semantic: true, sticky: false })
//   -> CJK semantic units only
//
//   buildPostLyricLayoutUnits(line, { semantic: true, sticky: true })
//   -> CJK semantic units, then punctuation/contraction attachment
export const buildPostLyricLayoutUnits = (
    line: SegmentableLine,
    options: BuildPostLyricLayoutUnitsOptions = {}
): LyricLayoutUnit[] => {
    const rawUnits = options.semantic
        ? buildCjkSemanticLayoutUnits(line)
        : createSingleWordLayoutUnits(line.words);

    return options.sticky
        ? applyStickyPunctuationLayoutUnits(rawUnits)
        : rawUnits;
};

// Converts layout units into the words a renderer should actually draw.
// Sticky non-semantic units become one rendered Word, e.g. It + ’ + s -> It’s.
// Semantic CJK units return their original words so per-character timing remains available.
export const buildDisplayWordsFromLayoutUnits = (units: LyricLayoutUnit[]): Word[] => units.flatMap(unit => {
    if (!unit.isSticky || unit.isSemantic) {
        return unit.words;
    }

    return [{
        text: unit.text,
        startTime: unit.startTime,
        endTime: unit.endTime,
    }];
});
