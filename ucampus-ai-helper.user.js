// ==UserScript==
// @name         U校园 AI 答题助手（半自动 · 优化版）
// @name:zh-CN   U校园 AI 答题助手
// @namespace    https://tampermonkey.net/
// @version      2.4.2
// @description  U校园网页答题助手，支持自定义 OpenAI 兼容 API、模型选择和手动或自动填入；答案由用户核对并提交。
// @author       DreamYuande
// @copyright    2026 DreamYuande
// @homepageURL  https://github.com/DreamYuande/ucampus-ai-helper
// @supportURL   https://github.com/DreamYuande/ucampus-ai-helper/issues
// @updateURL    https://github.com/DreamYuande/ucampus-ai-helper/releases/latest/download/ucampus-ai-helper.user.js
// @downloadURL  https://github.com/DreamYuande/ucampus-ai-helper/releases/latest/download/ucampus-ai-helper.user.js
// @match        *://*.unipus.cn/*
// @match        *://u.unipus.cn/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      api.deepseek.com
// @connect      *
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    // 防止 SPA 重复注入
    if (window.__UCAMPUS_AI_HELPER_V2__) return;
    window.__UCAMPUS_AI_HELPER_V2__ = true;

    /* =====================================================================
     * 1. 配置
     * =================================================================== */
    const CFG = {
        defaultBase: 'https://api.deepseek.com',
        defaultModel: 'deepseek-chat',
        API_STORE: 'uc_ai_api_config',
        timeoutMs: 60000,
        maxQuestionChars: 2500,
        cacheLimit: 30,
        frameWaitMs: 500,
        KEY_STORE: 'uc_ai_api_key',
        MODEL_STORE: 'uc_ai_model',
        POS_STORE: 'uc_ai_panel_pos_rb',
    };

    const IS_TOP = (() => {
        try { return window.top === window.self; } catch (e) { return false; }
    })();

    /* =====================================================================
     * 2. 存储与通用工具
     * =================================================================== */
    const store = {
        get(key, def) {
            try {
                if (typeof GM_getValue === 'function') {
                    const v = GM_getValue(key, null);
                    return v === null || v === undefined ? def : v;
                }
                const raw = localStorage.getItem(key);
                return raw === null ? def : JSON.parse(raw);
            } catch (e) { return def; }
        },
        set(key, val) {
            try {
                if (typeof GM_setValue === 'function') return GM_setValue(key, val);
                localStorage.setItem(key, JSON.stringify(val));
            } catch (e) { /* 忽略隐私模式等异常 */ }
        },
    };

    const $all = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

    function cleanText(t) {
        return String(t || '')
            .replace(/\u00a0/g, ' ')
            .replace(/[ \t]+$/gm, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    function isVisible(el) {
        if (!el || el.nodeType !== 1) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
        return !el.closest('[hidden],[aria-hidden="true"]');
    }

    function inViewport(el) {
        const r = el.getBoundingClientRect();
        const vw = window.innerWidth || 0;
        const vh = window.innerHeight || 0;
        return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    }

    /* =====================================================================
     * 3. 题目提取
     * =================================================================== */

    // 这些行属于页面噪音，不送进模型
    const NOISE_LINE = new RegExp(
        '^(' +
        '查看解析|收起解析|解析|答案解析|答案|正确答案|我的答案|' +
        '提交答案|保存并提交|提交|确定|取消|关闭|' +
        '下一题|上一题|返回|答题卡|收藏|纠错|分享|全屏|' +
        '重新作答|重做|跳过|开始答题|继续答题|' +
        '提示|帮助|题目来源|来源|单元测试|随堂测试|' +
        '剩余时间.*|用时.*|已用时.*|音频|视频|播放|暂停|重播|字幕|' +
        '输入答案|请输入.*' +
        ')$'
    );

    // 候选容器：由具体到宽泛，全部参与打分（不要取第一个命中就返回）
    const BLOCK_SELECTORS = [
        '[class*="question-item"]',
        '[class*="questionItem"]',
        '[class*="question-wrap"]',
        '[class*="questionWrap"]',
        '[class*="question-content"]',
        '[class*="questionContent"]',
        '[class*="question-container"]',
        '[class*="stem"]',
        '[class*="subject-"]',
        '.question',
        '.que-item',
    ];

    function collectCandidates() {
        const map = new Map();

        const push = (el, weight) => {
            if (!el || el.nodeType !== 1) return;
            if (!isVisible(el) || !inViewport(el)) return;
            const text = cleanText(el.innerText);
            if (text.length < 8 || text.length > 8000) return;
            const prev = map.get(el);
            if (prev) prev.weight = Math.max(prev.weight, weight);
            else map.set(el, { el: el, text: text, weight: weight });
        };

        BLOCK_SELECTORS.forEach((sel, idx) => {
            const w = 1 + (BLOCK_SELECTORS.length - idx) * 0.05;
            try { $all(sel).forEach((el) => push(el, w)); } catch (e) { /* 无效选择器 */ }
        });

        // 兜底：屏幕正中央的容器，通常就是当前正在做的题
        if (!map.size) {
            try {
                const el = document.elementFromPoint(
                    (window.innerWidth || 0) / 2,
                    (window.innerHeight || 0) / 2
                );
                if (el) push(el.closest('div,section,li,article') || el, 0.6);
            } catch (e) { /* 忽略 */ }
        }

        return Array.from(map.values());
    }

    function scoreCandidate(cand) {
        const el = cand.el;
        const text = cand.text;
        let s = 0;

        s += Math.min(text.length, 1500) / 60;                 // 内容量适中加分
        if (text.length > 4000) s -= 4;                         // 太长多半是整页容器

        const controls = el.querySelectorAll(
            'input[type=radio],input[type=checkbox],textarea,input[type=text]'
        );
        s += Math.min(controls.length, 8) * 0.9;                // 带答题控件加分

        if (/^[A-D][.．、)\s]/m.test(text)) s += 1.4;           // 有 A/B/C/D 选项
        if (/_{2,}|（\s*）|\(\s*\)/.test(text)) s += 1.0;       // 有空格待填
        if (/翻译|作文|writing|translate/i.test(text)) s += 0.4;

        // 越靠近视口竖直中央，越可能是当前题
        const r = el.getBoundingClientRect();
        const vh = window.innerHeight || 1;
        const centerDelta = Math.abs((r.top + r.bottom) / 2 - vh / 2) / vh;
        s += 1 - Math.min(centerDelta, 1);

        return s * cand.weight;
    }

    function analyze(el, rawText) {
        const optInputs = $all('input[type=radio],input[type=checkbox]', el);
        const hasChoice = optInputs.length >= 2 && optInputs.length <= 8;
        const isMulti = hasChoice && optInputs.some((i) => i.type === 'checkbox');

        // 用 DOM 控件反推选项文本，比依赖类名可靠
        const options = [];
        if (hasChoice) {
            const seen = new Set();
            optInputs.forEach((inp) => {
                const holder = inp.closest('label,li,[class*="option"],[class*="choice"],p') ||
                    inp.parentElement;
                const t = holder ? cleanText(holder.innerText).split('\n')[0] : '';
                if (t && t.length <= 120 && !seen.has(t)) {
                    seen.add(t);
                    options.push(t);
                }
            });
        }

        const checked = hasChoice
            ? optInputs.filter((i) => i.checked)
                .map((i) => {
                    const h = i.closest('label,li,[class*="option"],[class*="choice"]') || i.parentElement;
                    return h ? cleanText(h.innerText).split('\n')[0] : '';
                })
                .filter(Boolean)
            : [];

        const blankByText = (rawText.match(/_{2,}/g) || []).length;
        const blankByInput = el.querySelectorAll('input[type=text],input:not([type]),textarea').length;
        const blanks = Math.max(blankByText, blankByInput, 0);

        // 清洗噪音行
        const seenShort = new Set();
        const lines = cleanText(rawText)
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
            .filter((s) => !NOISE_LINE.test(s))
            .filter((s) => {
                if (s.length > 6) return true;           // 长句一律保留
                if (seenShort.has(s)) return false;      // 短标签去重
                seenShort.add(s);
                return true;
            });

        let text = lines.join('\n');
        if (options.length >= 2) {
            const letters = 'ABCDEFGH';
            const norm = (s) => s.replace(/^\s*[A-Ha-h]\s*[.．、)]\s*/, '').replace(/\s+/g, ' ').trim();
            const optSet = new Set(options.map(norm));

            // 原文里已有的选项行先剔除，统一由 DOM 选项重建，避免重复
            text = text
                .split('\n')
                .filter((line) => !optSet.has(norm(line)) && !optSet.has(line.trim()))
                .join('\n');

            const optionBlock = options
                .map((t, i) => {
                    const stripped = t.replace(/^\s*([A-Ha-h])\s*[.．、)]\s*/, (m, g) => g.toUpperCase() + '. ');
                    return /^[A-H]\.\s/.test(stripped) ? stripped : letters[i] + '. ' + t;
                })
                .join('\n');

            text = (text ? text + '\n' : '') + optionBlock;
        }

        text = text.slice(0, CFG.maxQuestionChars);

        let type = 'translate';
        if (isMulti) type = 'multiple';
        else if (options.length >= 2) type = 'single';
        else if (blanks > 0) type = 'blank';
        else if (/翻译|translate|写作|作文|writing|composition/i.test(text)) type = 'translate';
        else if (/判断|对错|true|false/i.test(text)) type = 'judge';

        return {
            text: text,
            type: type,
            options: options,
            blanks: blanks,
            checked: checked,
            score: 0,
        };
    }

    // PC 课程的分栏题将作答要求、原文和输入框渲染在三个不同区域。
    function readSplitWritingQuestion() {
        for (const layout of $all('[class*="pclayout--main-lr-"]')) {
            if (!isVisible(layout) || !inViewport(layout)) continue;

            const source = layout.querySelector(':scope > .left');
            const editor = layout.querySelector(':scope > .right');
            const directions = layout.querySelector('[class*="pclayout--direction-con-"]');
            if (!source || !editor || !directions || !isVisible(source) || !isVisible(directions)) continue;

            const boxes = $all('textarea', editor).filter((box) => isVisible(box) && !box.disabled && !box.readOnly);
            if (boxes.length !== 1) continue;

            const instruction = cleanText(directions.innerText);
            if (!/\b(?:translate|write|writing|translation|composition)\b|翻译|译成|写作|作文/i.test(instruction)) continue;

            const passage = cleanText(source.innerText);
            const text = [instruction, passage].filter(Boolean).join('\n\n').slice(0, CFG.maxQuestionChars);
            if (text.length < 8) continue;

            return { text, type: 'translate', options: [], blanks: 0, checked: [], score: 100, el: editor };
        }
        return null;
    }

    function rewriteRows(group) {
        return $all('textarea.scoopFill_textarea', group).filter(isVisible).map((box) => {
            const row = box.closest('[class*="questions--questionDefault-"]');
            return { box, text: row && row !== group ? cleanText(row.innerText) : '' };
        });
    }

    function readRewriteQuestion() {
        for (const layout of $all('[class*="pclayout--main-top-"]')) {
            if (!isVisible(layout) || !inViewport(layout)) continue;
            const directions = layout.parentElement?.querySelector('[class*="pclayout--direction-con-"]');
            if (!isVisible(directions)) continue;
            const instruction = cleanText(directions.innerText);
            if (!/\b(?:rewrite|rephrase|transform)\b|改写|句型转换/i.test(instruction)) continue;

            const group = layout.querySelector('.questions');
            if (!isVisible(group)) continue;
            const rows = rewriteRows(group);
            if (!rows.length || rows.some(({ box, text }) => !text || box.disabled || box.readOnly)) continue;

            const example = layout.querySelector('[class*="questions--combinationWrap-"]');
            const questions = rows.map(({ text }, i) => (i + 1) + '. ' + text.replace(/^\d+\s*[.、．)]\s*/, '')).join('\n');
            const exampleText = isVisible(example) ? cleanText(example.innerText) : '';
            const sections = [instruction];
            if (exampleText && instruction.length + exampleText.length + questions.length + 16 <= CFG.maxQuestionChars) {
                sections.push('示例（仅供参考）：\n' + exampleText);
            }
            sections.push('待作答：\n' + questions);
            const text = sections.join('\n\n');
            if (text.length > CFG.maxQuestionChars) continue;
            return { text, type: 'rewrite', options: [], blanks: rows.length, checked: [], score: 100, el: group };
        }
        return null;
    }

    const MATCH_TABLE = 'table[class*="sequence-pc--sequence-table-"]';
    const MATCH_CARD = '[class*="sequence-pc-card--item-"]';

    function readMatchingRows(table) {
        return Array.from(table.rows).filter(isVisible).map((row) => {
            const card = row.cells[1]?.querySelector(MATCH_CARD);
            const caption = card?.querySelector('[class*="sequence-pc-card--caption-item-"]');
            const option = card?.querySelector(':scope > .html-view');
            return {
                card,
                left: cleanText(row.cells[0]?.innerText).replace(/^\d+\s*[.．、)]\s*/, ''),
                label: cleanText(caption?.innerText).replace(/[.．、)]$/, '').trim().toUpperCase(),
                right: cleanText(option?.innerText),
            };
        });
    }

    function readMatchingQuestion() {
        for (const table of $all(MATCH_TABLE)) {
            if (!isVisible(table) || !inViewport(table)) continue;
            const layout = table.closest('[class*="pclayout--main-lr-"],[class*="pclayout--main-top-"]');
            const directions = layout?.querySelector('[class*="pclayout--direction-con-"]') ||
                layout?.parentElement?.querySelector('[class*="pclayout--direction-con-"]');
            const instruction = isVisible(directions) ? cleanText(directions.innerText) : '';
            if (!/\b(?:match|rearrange|pairs?)\b|配对|匹配|连线/i.test(instruction)) continue;

            const rows = readMatchingRows(table);
            if (rows.length < 2 || rows.length > 26 || rows.some((r) => !r.left || !r.right || !/^[A-Z]$/.test(r.label))) continue;
            if (new Set(rows.map((r) => r.label)).size !== rows.length || new Set(rows.map((r) => r.right)).size !== rows.length) continue;
            const left = rows.map((r, i) => (i + 1) + '. ' + r.left);
            const right = rows.map((r) => r.label + '. ' + r.right).sort();
            const text = [instruction, '左列：\n' + left.join('\n'), '右列：\n' + right.join('\n')].join('\n\n');
            if (text.length > CFG.maxQuestionChars) continue;
            return { text, type: 'match', options: [], blanks: rows.length, checked: [], score: 100, el: table, matchRows: rows };
        }
        return null;
    }

    function bestFromDOM(requireRecognized = false) {
        const structuredQuestion = readMatchingQuestion() || readSplitWritingQuestion() || readRewriteQuestion();
        if (structuredQuestion) return structuredQuestion;

        const cands = collectCandidates().map((c) => {
            const info = analyze(c.el, c.text);
            info.score = scoreCandidate(c) + (info.type !== 'translate' ? 0.5 : 0);
            info.el = c.el;
            info.autoRecognized = c.weight >= 1 || !!c.el.querySelector('textarea,input[type=text],input[type=radio],[contenteditable="true"]');
            return info;
        }).filter((q) => !requireRecognized || q.autoRecognized);
        cands.sort((a, b) => b.score - a.score);
        return cands[0] || null;
    }

    /* =====================================================================
     * 4. 跨 iframe 取题（U校园题目常嵌在 iframe 里）
     * =================================================================== */
    const touchedCards = new WeakSet();
    document.addEventListener('dragstart', (e) => {
        if (!e.isTrusted) return;
        const table = e.target.closest?.(MATCH_TABLE);
        if (table) touchedCards.add(table);
    }, true);

    function isUntouched(q) {
        if (!q.el?.isConnected) return false;
        if (q.type === 'match') {
            return !touchedCards.has(q.el) && q.matchRows?.every((row) => row.card?.draggable);
        }
        const choice = q.type === 'single' || q.type === 'multiple';
        const selector = choice ? 'input[type=radio],input[type=checkbox]' :
            q.type === 'rewrite' ? 'textarea.scoopFill_textarea' :
            'input[type=text],input:not([type]),textarea,[contenteditable="true"]';
        const controls = $all(selector, q.el).filter((el) => isVisible(el) || (choice && isVisible(el.closest('label'))));
        if (choice && (controls.length !== q.options.length || controls.length < 2)) return false;
        if (q.type === 'blank' && controls.length !== q.blanks) return false;
        return controls.length > 0 && controls.every((el) =>
            !el.disabled && !el.readOnly && document.activeElement !== el &&
            (choice ? !el.checked : !cleanText(el.isContentEditable ? el.innerText : el.value))
        );
    }

    function questionIdentity(q) {
        return q.matchRows ? JSON.stringify([q.matchRows.map((r) => r.left), q.matchRows.map((r) => r.right).sort()]) : q.text;
    }

    function sameQuestion(a, b) {
        return !!a && !!b && a.type === b.type && a.text === b.text && a._frame === b._frame && a._origin === b._origin;
    }

    function isCourseOrigin(origin) {
        try {
            const u = new URL(origin);
            return /^https?:$/.test(u.protocol) && /(?:^|\.)unipus\.cn$/.test(u.hostname);
        } catch (e) { return false; }
    }

    function packQuestion(info) {
        if (!info) return null;
        return {
            text: info.text, type: info.type, options: info.options, blanks: info.blanks,
            checked: info.checked, score: info.score, identity: questionIdentity(info), untouched: isUntouched(info),
        };
    }

    function installFrameAgent() {
        window.addEventListener('message', async (ev) => {
            const d = ev.data;
            if (!d || ev.source !== window.parent || !isCourseOrigin(ev.origin)) return;

            if (d.__ucAI === 'ask') {
                const best = bestFromDOM(d.recognized === true);
                ev.source.postMessage({ __ucAI: 'reply', id: d.id, question: packQuestion(best) }, ev.origin);
            } else if (d.__ucAI === 'fill') {
                let result;
                try {
                    const current = bestFromDOM(d.untouched === true);
                    result = sameQuestion(current, d.expected) && (!d.untouched || isUntouched(current))
                        ? await fillAnswer(current, current.el, d.answer)
                        : { filled: 0, total: d.expected?.blanks || 1, note: '题目或作答状态有变化，请核对后重新取题' };
                } catch (e) {
                    result = { filled: 0, total: d.expected?.blanks || 1, note: '填入时出错' };
                }
                ev.source.postMessage({ __ucAI: 'filled', id: d.id, result }, ev.origin);
            }
        });
    }

    function askFrames(timeoutMs, recognized) {
        const frames = $all('iframe,frame').filter((f) => isVisible(f) && inViewport(f));
        if (!frames.length) return Promise.resolve([]);

        return new Promise((resolve) => {
            const id = 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
            const found = [];
            const onMsg = (ev) => {
                const d = ev.data;
                if (!d || d.__ucAI !== 'reply' || d.id !== id || typeof d.question?.text !== 'string' || !isCourseOrigin(ev.origin)) return;
                const frame = frames.find((f) => f.contentWindow === ev.source);
                if (frame) found.push({ ...d.question, _frame: frame, _origin: ev.origin });
            };
            window.addEventListener('message', onMsg);
            frames.forEach((f) => {
                try { f.contentWindow.postMessage({ __ucAI: 'ask', id, recognized }, '*'); } catch (e) { /* iframe 已关闭 */ }
            });
            setTimeout(() => {
                window.removeEventListener('message', onMsg);
                resolve(found);
            }, timeoutMs);
        });
    }

    async function extractQuestion(recognized = false) {
        const local = bestFromDOM(recognized);
        if (local?.score === 100 && !local.autoRecognized) return local;
        const remote = await askFrames(CFG.frameWaitMs, recognized);
        const all = (local ? [local] : []).concat(remote);
        all.sort((a, b) => (b.score || 0) - (a.score || 0));
        return all[0] || null;
    }

    /* ---- 把答案填回去：可能在本帧，也可能在 iframe 里 ---- */
    function fillInFrame(q, answer, untouchedOnly, timeoutMs) {
        const frameEl = q._frame;
        return new Promise((resolve) => {
            const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            let timer = null;

            const cleanup = () => {
                if (timer) clearTimeout(timer);
                window.removeEventListener('message', onMsg, false);
            };
            const onMsg = (ev) => {
                const d = ev.data;
                if (!d || d.__ucAI !== 'filled' || d.id !== id || ev.source !== frameEl.contentWindow || ev.origin !== q._origin) return;
                cleanup();
                resolve(d.result || null);
            };

            window.addEventListener('message', onMsg, false);
            timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs || 3000);

            try {
                frameEl.contentWindow.postMessage({ __ucAI: 'fill', id, answer, untouched: untouchedOnly, expected: { type: q.type, text: q.text, blanks: q.blanks } }, q._origin);
            } catch (e) {
                cleanup();
                resolve(null);
            }
        });
    }

    async function applyAnswer(q, answer, canContinue = () => true, untouchedOnly = false) {
        const empty = { filled: 0, total: 0, note: '没有可填写的题目' };
        if (!q || !canContinue()) return empty;

        if (q._frame) {
            const r = await fillInFrame(q, answer, untouchedOnly, 3000);
            return r || { filled: 0, total: 0, note: 'iframe 内填入超时' };
        }

        let el = q.el;
        // SPA 可能已经重渲染，元素脱离文档就重新取一次当前题
        if (!el || !document.contains(el)) {
            const fresh = bestFromDOM();
            if (!fresh || fresh.type !== q.type || fresh.text !== q.text) return { filled: 0, total: q.blanks || 1, note: '题目已失效，请重新取题' };
            el = fresh.el;
            q = fresh;
        }
        return fillAnswer(q, el, answer, canContinue);
    }

    /* =====================================================================
     * 5. 提示词
     * =================================================================== */
    function buildMessages(q) {
        const sys =
            '你是一位经验丰富的大学英语教师，也是严格的阅卷人。' +
            '你只输出可以直接填写或勾选的答案，绝不输出题目复述、解析或客套话。' +
            '如果题目信息不足以作答，只输出四个字：信息不足。';

        const rules = {
            single: '题型：单选题。只输出一个选项字母（例如 B），不要输出其他任何字符。',
            multiple: '题型：多选题。按字母升序输出全部正确选项字母（例如 ABD），不要输出其他内容。',
            judge: '题型：判断题。只输出「对」或「错」。',
            blank: '题型：填空题，共 ' + (q.blanks || 1) + ' 个空。按空格在题目中出现的顺序输出，' +
                '每行只写一个空的答案，不要编号、不要解释；单词保持题目要求的形态，不加句号。',
            match: '题型：配对，共 ' + q.blanks + ' 组。按左列题号顺序，输出对应的右列字母组成的 JSON 数组。只输出数组，每个字母只能用一次。',
            rewrite: '题型：句型改写，共 ' + q.blanks + ' 道小题。只改写「待作答」里的句子，按题号顺序每行输出一个完整句子，保留句末标点，不要编号，也不要输出示例或解释。',
            translate: '题型：翻译或写作。直接给出完整译文或作文正文，不要复述题目，不要解释，不要加引号。',
        };

        let user = rules[q.type] || rules.translate;
        if (q.checked && q.checked.length) {
            user += '\n（页面当前已选：' + q.checked.join('；') + '，可供参考，但请独立判断。）';
        }
        user += '\n\n===== 题目原文 =====\n' + q.text;

        return [
            { role: 'system', content: sys },
            { role: 'user', content: user },
        ];
    }

    function cleanAnswer(raw) {
        return String(raw || '')
            .replace(/^\s*```[a-zA-Z]*\s*/, '')
            .replace(/\s*```\s*$/, '')
            .replace(/^\s*(参考答案|正确答案|答案|Answer)\s*[:：]\s*/i, '')
            .replace(/[ \t]+$/gm, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    /* =====================================================================
     * 6. 网络请求
     * =================================================================== */
    const cache = new Map();
    let cacheConfig = null;

    function normalizeBase(raw) {
        const value = String(raw || '').trim();
        let url;
        try { url = new URL(value); } catch (e) { throw new Error('请输入以 https:// 或 http:// 开头的 API 地址'); }
        if (!/^https?:\/\//i.test(value) || !['https:', 'http:'].includes(url.protocol) || /[?#\s\\]/.test(value) || url.username || url.password) {
            throw new Error('API 地址只支持 HTTP(S)，请去掉账号、参数或片段');
        }
        const path = url.pathname.replace(/\/+$/, '');
        const basePath = path.replace(/\/(?:chat\/completions|models)$/i, '');
        return url.origin + basePath;
    }

    function getApiConfig() {
        if (typeof GM_getValue === 'function') {
            const saved = GM_getValue(CFG.API_STORE, null);
            if (saved && typeof saved.base === 'string') {
                return { base: saved.base, key: String(saved.key || ''), model: String(saved.model || ''), saved: true };
            }
            return {
                base: CFG.defaultBase,
                key: String(GM_getValue(CFG.KEY_STORE, '') || '').trim(),
                model: String(GM_getValue(CFG.MODEL_STORE, CFG.defaultModel) || CFG.defaultModel).trim(),
                saved: false,
            };
        }
        return { base: CFG.defaultBase, key: '', model: CFG.defaultModel, saved: false };
    }

    function apiError(message, code) {
        return Object.assign(new Error(message), { code });
    }

    function httpMessage(status, isList) {
        const map = {
            400: '请求参数有误，请检查模型 ID 和接口兼容性',
            401: '认证失败，请检查 API Key 是否与此地址匹配',
            402: '账户余额不足，请检查服务商账户',
            403: '访问受限，请检查服务商权限或扩展的域名授权',
            404: isList ? '服务未找到 /models，请检查 API 地址或手动输入模型 ID' : '服务未找到 /chat/completions 或所选模型，请检查地址和模型 ID',
            405: isList ? '服务不支持读取模型列表，可手动输入模型 ID' : '此地址不支持 Chat Completions 请求',
            422: '参数校验失败，请检查模型 ID 和接口兼容性',
            429: '请求太频繁，请稍后再试',
        };
        return (map[status] || (status >= 500 ? 'API 服务暂不可用' : 'API 请求失败')) + '（HTTP ' + status + '）';
    }

    function requestJson(config, endpoint, payload) {
        const isList = endpoint === '/models';
        const headers = { Accept: 'application/json' };
        if (config.key) headers.Authorization = 'Bearer ' + config.key;
        if (!isList) headers['Content-Type'] = 'application/json';
        const networkError = '连接 API 失败，请检查地址、网络和油猴的域名访问权限';

        return new Promise((resolve, reject) => {
            const fail = (message, code) => reject(apiError(message, code));
            if (typeof GM_xmlhttpRequest !== 'function') {
                fail('请通过 Tampermonkey 安装并运行此脚本', 'extension');
                return;
            }
            try {
                GM_xmlhttpRequest({
                    method: isList ? 'GET' : 'POST',
                    url: config.base + endpoint,
                    headers,
                    data: isList ? undefined : JSON.stringify(payload),
                    timeout: isList ? 12000 : CFG.timeoutMs,
                    anonymous: true,
                    redirect: 'error',
                    onload: (res) => {
                        if (!res.status) { fail(networkError, 'network'); return; }
                        if (res.status < 200 || res.status >= 300) { fail(httpMessage(res.status, isList), res.status); return; }
                        try { resolve(JSON.parse(res.responseText)); }
                        catch (e) { fail('API 返回的内容不是 JSON，请检查 API 地址', 'parse'); }
                    },
                    onerror: () => fail(networkError, 'network'),
                    ontimeout: () => fail('请求超时，请检查网络后重试', 'timeout'),
                    onabort: () => fail('请求已取消', 'abort'),
                });
            } catch (e) {
                fail(networkError, 'network');
            }
        });
    }

    async function fetchModels(config) {
        const json = await requestJson(config, '/models');
        if (!Array.isArray(json?.data)) throw new Error('模型列表格式不兼容，请手动输入模型 ID');
        const ids = json.data.map((m) => typeof m?.id === 'string' ? m.id.trim() : '').filter(Boolean);
        return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
    }

    async function requestAnswer(config, payload) {
        const json = await requestJson(config, '/chat/completions', payload);
        const msg = json?.choices?.[0]?.message;
        if (!msg || typeof msg.content !== 'string') {
            throw apiError('接口未返回文本答案，请检查所选模型是否支持 Chat Completions', 'parse');
        }
        return cleanAnswer(msg.content);
    }

    async function askWithRetry(config, payload) {
        try {
            return await requestAnswer(config, payload);
        } catch (e) {
            if (![429, 500, 502, 503, 'network'].includes(e.code)) throw e;
            await new Promise((resolve) => setTimeout(resolve, 1200));
            return requestAnswer(config, payload);
        }
    }

    async function getAnswer(q, config, manual = false) {
        if (!cacheConfig || cacheConfig.base !== config.base || cacheConfig.key !== config.key || cacheConfig.model !== config.model) {
            cache.clear();
            cacheConfig = config;
        }
        const payload = { model: config.model, messages: buildMessages(q), stream: false };
        const cacheKey = JSON.stringify(payload.messages);
        if (!manual && cache.has(cacheKey)) return cache.get(cacheKey);

        const answer = await (manual ? askWithRetry(config, payload) : requestAnswer(config, payload));
        if (answer) cache.set(cacheKey, answer);
        if (cache.size > CFG.cacheLimit) cache.delete(cache.keys().next().value);
        return answer;
    }

    /* =====================================================================
     * 6.5 自动填入（只填答案，绝不点提交）
     * =================================================================== */

    // 把模型答案转成选项下标；支持 "B" / "ABD" / "B、D" / "B. to carry out"
    function lettersToIndexes(rawAnswer, count) {
        const ans = String(rawAnswer || '').trim();
        const compact = ans.replace(/[\s,，、/;；·]/g, '').toUpperCase();

        const out = [];
        const push = (i) => {
            if (i >= 0 && i < count && out.indexOf(i) < 0) out.push(i);
        };

        // 1) 纯字母组合
        if (compact && /^[A-H]+$/.test(compact) && compact.length <= count) {
            compact.split('').forEach((ch) => push(ch.charCodeAt(0) - 65));
        }
        // 2) 行首/开头的字母，如 "B. xxx"、"（C）"
        if (!out.length) {
            const m = ans.match(/^[\s（(]*([A-Ha-h])[\s.．、)）]/);
            if (m) push(m[1].toUpperCase().charCodeAt(0) - 65);
        }
        // 3) 答案里出现独立的字母串，如 "答案是 BD"、"answer: C"
        if (!out.length) {
            const ms = ans.match(/(?:^|[^A-Za-z])([A-H]{1,8})(?![A-Za-z])/g) || [];
            ms.forEach((tok) => {
                const ch = tok.replace(/[^A-H]/g, '');
                ch.split('').forEach((c) => push(c.charCodeAt(0) - 65));
            });
        }
        return out.sort((a, b) => a - b);
    }

    // 字母对不上时，用选项原文反查下标
    function matchByText(rawAnswer, options) {
        const ans = String(rawAnswer || '').replace(/\s+/g, ' ').trim();
        if (!ans) return [];
        const norm = (s) => String(s)
            .replace(/^\s*[A-Ha-h]\s*[.．、)]\s*/, '')
            .replace(/\s+/g, ' ')
            .trim();

        // 先找完全相同的选项
        const exact = [];
        (options || []).forEach((opt, i) => { if (norm(opt) === ans) exact.push(i); });
        if (exact.length) return exact;

        // 再找被答案包含的选项（太短的选项不算，避免误配）
        const out = [];
        (options || []).forEach((opt, i) => {
            const t = norm(opt);
            if (t && t.length > 3 && ans.indexOf(t) >= 0) out.push(i);
        });
        return out;
    }

    // 绕过 React/Vue 的受控 value，必须走原生 setter 再派发事件
    function setNativeValue(el, value) {
        try { el.focus({ preventScroll: true }); } catch (e) { /* 忽略 */ }

        let proto = null;
        if (el.tagName === 'TEXTAREA') proto = window.HTMLTextAreaElement && HTMLTextAreaElement.prototype;
        else if (el.tagName === 'INPUT') proto = window.HTMLInputElement && HTMLInputElement.prototype;

        const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
        try {
            if (desc && desc.set) desc.set.call(el, value);
            else el.value = value;
        } catch (e) {
            el.value = value;
        }

        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // 勾选/取消某选项，点 label 触发页面自己的选中逻辑
    function setChecked(inp, want) {
        if (inp.checked === want) return true;

        const label = inp.closest('label');
        try { (label || inp).click(); } catch (e) { /* 忽略 */ }
        if (inp.checked !== want) {
            inp.checked = want;
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return inp.checked === want;
    }

    function answerLines(raw) {
        return String(raw || '')
            .split('\n')
            .map((s) => s.replace(/^\s*\d+\s*[.、)]\s*/, '').trim())   // 去掉 "1." 之类编号
            .filter(Boolean);
    }

    /**
     * 把答案填进题目元素。
     * @returns {{filled:number,total:number,note:string}}
     */
    function matchingOrder(answer, rows) {
        let labels;
        try { labels = JSON.parse(answer); } catch (e) { return null; }
        if (!Array.isArray(labels) || labels.length !== rows.length) return null;
        const cards = new Map(rows.map((row) => [row.label, row.right]));
        const order = labels.map((label) => cards.get(String(label).trim().toUpperCase()));
        return order.every(Boolean) && new Set(order).size === rows.length ? order : null;
    }

    async function fillMatching(info, table, answer, canContinue) {
        const result = { filled: 0, total: info.blanks, note: '' };
        const current = readMatchingQuestion();
        if (current?.el !== table || current.text !== info.text) {
            result.note = '题目或卡片标签已变化，请重新取题';
            return result;
        }
        const target = matchingOrder(answer, current.matchRows);
        if (!target) {
            result.note = '模型返回的配对有遗漏或重复，请核对后手动拖动';
            return result;
        }

        const left = current.matchRows.map((row) => row.left);
        for (let index = 0; index < target.length; index++) {
            const rows = readMatchingRows(table);
            if (!table.isConnected || !canContinue() || rows.length !== left.length || rows.some((row, i) => row.left !== left[i])) {
                result.note = '页面已变化，停止填入';
                break;
            }
            if (rows[index].right === target[index]) continue;
            const from = rows.find((row) => row.right === target[index])?.card;
            const to = rows[index].card;
            if (!from?.draggable || !to?.draggable) {
                result.note = '页面未开放拖动，请按答案手动配对';
                break;
            }

            const transfer = new DataTransfer();
            const dispatch = (el, type, rect) => el.dispatchEvent(new DragEvent(type, {
                bubbles: true, cancelable: true, dataTransfer: transfer,
                clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height * .15,
            }));
            const fromRect = from.getBoundingClientRect();
            const toRect = to.getBoundingClientRect();
            dispatch(from, 'dragstart', fromRect);
            dispatch(to, 'dragenter', toRect);
            dispatch(to, 'dragover', toRect);
            try {
                if (canContinue()) dispatch(to, 'drop', toRect);
            } finally {
                dispatch(from.isConnected ? from : table, 'dragend', fromRect);
            }
            await new Promise((resolve) => setTimeout(resolve, 60));
            if (readMatchingRows(table)[index]?.right !== target[index]) {
                result.note = '页面未按预期移动卡片，请按答案手动核对';
                break;
            }
        }
        if (table.isConnected && canContinue()) {
            result.filled = readMatchingRows(table).filter((row, i) => row.left === left[i] && row.right === target[i]).length;
        }
        return result;
    }

    async function fillAnswer(info, el, rawAnswer, canContinue = () => true) {
        const res = { filled: 0, total: 0, note: '' };
        if (!el || !info) {
            res.note = '没有题目元素';
            return res;
        }
        const answer = String(rawAnswer || '').trim();
        if (!answer) {
            res.note = '答案为空';
            return res;
        }

        if (info.type === 'match') return fillMatching(info, el, answer, canContinue);

        /* ---- 句型改写 ---- */
        if (info.type === 'rewrite') {
            const current = readRewriteQuestion();
            const rows = rewriteRows(el);
            res.total = info.blanks;
            if (!current || current.el !== el || current.text !== info.text || rows.length !== res.total) {
                res.note = '题目已变化，请重新取题';
                return res;
            }
            const lines = answerLines(answer);
            if (lines.length !== res.total) {
                res.note = '答案行数与小题数不一致，请核对后手动填入';
                return res;
            }
            rows.forEach(({ box }, i) => {
                setNativeValue(box, lines[i]);
                if (box.value.trim() === lines[i]) res.filled++;
            });
            return res;
        }

        /* ---- 选择题 ---- */
        if (info.type === 'single' || info.type === 'multiple') {
            const inputs = $all('input[type=radio],input[type=checkbox]', el);
            const count = inputs.length;

            if (count >= 2) {
                res.total = count;
                let idx = lettersToIndexes(answer, count);
                if (!idx.length) idx = matchByText(answer, info.options);
                if (!idx.length) {
                    res.note = '没能从答案里认出选项字母';
                    return res;
                }

                inputs.forEach((inp, i) => {
                    const want = idx.indexOf(i) >= 0;
                    // 多选题顺手取消错误项；单选题只选正确项
                    if (want) {
                        if (setChecked(inp, true)) res.filled++;
                    } else if (info.type === 'multiple' && inp.checked) {
                        setChecked(inp, false);
                    }
                });
                return res;
            }

            // 没有原生 input：点自定义选项块
            const blocks = $all('[class*="option"],[class*="choice"],li', el)
                .filter((b) => isVisible(b) && b.innerText && b.innerText.trim().length < 160);
            if (blocks.length >= 2) {
                res.total = blocks.length;
                const picked = lettersToIndexes(answer, blocks.length);
                const targets = picked.length ? picked : matchByText(answer, info.options);
                if (!targets.length) {
                    res.note = '自定义选项，无法定位正确答案';
                    return res;
                }
                targets.forEach((i) => {
                    try { blocks[i].click(); res.filled++; } catch (e) { /* 忽略 */ }
                });
                return res;
            }

            res.note = '这道题没有找到选项控件';
            return res;
        }

        /* ---- 填空 / 翻译 / 写作 ---- */
        const boxes = $all('input[type=text],input:not([type]),textarea', el)
            .filter((b) => isVisible(b))
            .filter((b) => {
                const t = String(b.type || 'text').toLowerCase();
                return ['text', 'search', 'url', 'email', 'tel'].indexOf(t) >= 0 || b.tagName === 'TEXTAREA';
            });

        const lines = answerLines(answer);

        if (boxes.length) {
            res.total = boxes.length;

            let vals;
            if (info.type === 'blank') {
                if (lines.length === boxes.length) {
                    vals = lines;
                } else {
                    const flat = lines.join(' ').split(/\s+/).filter(Boolean);
                    vals = boxes.length === 1
                        ? [lines.join(' ')]
                        : (flat.length === boxes.length ? flat : boxes.map((_, i) => lines[i] || flat[i] || ''));
                }
            } else {
                // 翻译/写作：整段文本塞进第一个可编辑框
                const whole = lines.join('\n');
                vals = boxes.map((_, i) => (i === 0 ? whole : ''));
            }

            boxes.forEach((box, i) => {
                const v = vals[i];
                if (!v) return;
                setNativeValue(box, v);
                if (String(box.value || '').trim() === String(v).trim()) res.filled++;
            });
            if (!res.filled) res.note = '写入后值没变化，页面可能禁止脚本输入';
            return res;
        }

        // 富文本编辑器（contenteditable）
        const ce = el.querySelector('[contenteditable="true"],[contenteditable=""]');
        if (ce) {
            res.total = 1;
            const whole = lines.join('\n');
            try { ce.focus(); } catch (e) { /* 忽略 */ }
            try {
                const range = document.createRange();
                range.selectNodeContents(ce);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
                document.execCommand('insertText', false, whole);
            } catch (e) { /* 继续走兜底 */ }

            if (String(ce.innerText || '').trim().indexOf(whole.slice(0, 20)) < 0) {
                ce.textContent = whole;
                ce.dispatchEvent(new InputEvent('input', { bubbles: true }));
            }
            res.filled = String(ce.innerText || '').trim() ? 1 : 0;
            if (!res.filled) res.note = '富文本框写入失败';
            return res;
        }

        res.note = '这道题没找到可填写的输入框';
        return res;
    }

    /* =====================================================================
     * 7. iframe 内的静默代理（不渲染任何界面）
     * =================================================================== */
    if (!IS_TOP) {
        installFrameAgent();
        return;
    }

    /* =====================================================================
     * 8. 界面（Shadow DOM 隔离，避免被页面样式影响）
     * =================================================================== */
    const CSS = `
        :host { all: initial; color-scheme: light; }
        *, *::before, *::after { box-sizing: border-box; }
        [hidden] { display: none !important; }
        .panel, .ball {
            --ink: #252c40; --muted: #566177; --line: #d7deec;
            --tint: #f3f3fd; --paper: #eef0f5; --white: #fff; --accent: #5048ad;
            position: fixed; right: 16px; bottom: 16px;
            right: max(16px, env(safe-area-inset-right)); bottom: max(16px, env(safe-area-inset-bottom));
            font: 12px/1.5 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
        }
        .panel {
            width: min(300px, calc(100vw - 24px)); max-height: calc(100vh - 24px); max-height: calc(100dvh - 24px);
            display: flex; flex-direction: column; overflow: hidden;
            background: var(--white); color: var(--ink); border: 1px solid var(--line);
            border-radius: 15px; box-shadow: 0 8px 28px rgb(28 37 58 / .14), 0 2px 5px rgb(28 37 58 / .06);
        }
        .hd { display: flex; flex: none; align-items: center; gap: 8px; padding: 8px 8px 8px 12px; background: var(--tint); cursor: move; touch-action: none; user-select: none; }
        .heading { flex: 1; min-width: 0; }
        .t { margin: 0; font-size: 14px; font-weight: 700; text-wrap: balance; }
        .version { color: var(--muted); font-variant-numeric: tabular-nums; }
        .bd { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; min-height: 0; overflow: auto; }
        .row { display: flex; gap: 6px; align-items: center; }
        .field { display: grid; gap: 4px; min-width: 0; }
        .field > label:not(.chk) { font-weight: 600; }
        .model-field { border-top: 1px solid var(--line); padding-top: 8px; }
        .chk { display: flex; gap: 6px; align-items: center; min-height: 30px; cursor: pointer; color: var(--muted); }
        .chk input { margin: 0; accent-color: var(--accent); }
        .advice, .tip, .model-tag, details, .foot { color: var(--muted); overflow-wrap: anywhere; }
        .advice strong { color: #a43c29; font-weight: 650; }
        .model-tag { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        input:not([type=checkbox]):not([type=radio]), select {
            width: 100%; min-width: 0; min-height: 34px; padding: 6px 8px;
            border: 1px solid var(--line); border-radius: 7px; background: var(--white); color: var(--ink); font: inherit;
        }
        input::placeholder { color: var(--muted); }
        select { overflow: hidden; text-overflow: ellipsis; }
        button { min-height: 34px; padding: 5px 9px; border-radius: 7px; white-space: nowrap; cursor: pointer;
            border: 1px solid transparent; background: var(--accent); color: var(--white); font: inherit;
            transition: background-color 120ms ease, transform 100ms ease; }
        button:hover:not(:disabled) { background: #403996; }
        button:active:not(:disabled) { transform: scale(.96); }
        button.ghost:not(:disabled), button:disabled, select:disabled { background: var(--paper); color: var(--muted); }
        button.ghost:not(:disabled) { color: var(--ink); }
        button.ghost:hover:not(:disabled) { background: #e3e6f0; }
        button:disabled { cursor: default; color: #647086; }
        button.x { width: 36px; height: 36px; padding: 0; background: transparent; color: var(--ink); font-size: 18px; }
        button.x:hover:not(:disabled) { background: #e7e7f7; }
        button.primary { font-weight: 650; }
        .actions .primary { flex: 1; }
        :focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
        .ans { min-height: 32px; max-height: 28vh; padding: 5px 8px; overflow: auto; border: 1px solid var(--line);
            border-radius: 7px; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
        .ans.empty, .st { color: var(--muted); }
        .st { overflow-wrap: anywhere; }
        .st.warn { color: #874917; } .st.err { color: #9a2534; } .st.ok { color: #176142; }
        .st:empty { display: none; }
        summary { min-height: 28px; padding: 4px 0; color: var(--accent); cursor: pointer; }
        details pre { margin: 0; padding: 6px; max-height: 100px; overflow: auto; background: var(--paper); border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere; }
        .foot { display: flex; flex: none; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 4px 8px;
            padding: 3px 12px; border-top: 1px solid #e7eaf2; font-variant-numeric: tabular-nums; }
        .foot a { display: inline-flex; min-height: 34px; align-items: center; gap: 5px; color: var(--accent); text-decoration: none; }
        .foot a:hover { text-decoration: underline; }
        .foot svg { width: 16px; height: 16px; fill: currentColor; }
        .ball { width: 42px; height: 42px; padding: 0; border-radius: 50%; font-size: 14px; font-weight: 650; box-shadow: 0 4px 16px rgb(28 37 58 / .20); }
        @media (max-width: 340px) { .panel, .ball { right: max(12px, env(safe-area-inset-right)); bottom: max(12px, env(safe-area-inset-bottom)); } }
        @media (pointer: coarse) { button, button.x, input:not([type=checkbox]):not([type=radio]), select, .foot a { min-height: 44px; } button.x, .ball { min-width: 44px; } }
        @media (prefers-reduced-motion: reduce) { button { transition: none; } button:active:not(:disabled) { transform: none; } }
    `;

    const HTML = `
        <section class="panel" id="panel" aria-labelledby="panel-title">
            <div class="hd" id="hd">
                <div class="heading">
                    <h2 class="t" id="panel-title" tabindex="-1">U校园 AI 答题助手</h2>
                    <div class="version">v2.4.2</div>
                </div>
                <button class="x" id="btn-min" title="收起" aria-label="收起为悬浮球" type="button">−</button>
            </div>
            <div class="bd" id="bd">
                <div class="advice"><strong>AI 答案仅供参考</strong> · 核对后手动提交</div>
                <div class="row">
                    <span class="model-tag" id="active-model"></span>
                    <button class="ghost" id="btn-settings" type="button" aria-controls="settings">API 设置</button>
                </div>
                <div class="st" id="st" role="status"></div>
                <div class="ans empty" id="ans" tabindex="0" aria-label="模型答案">答案显示在这里</div>
                <div class="row actions">
                    <button class="primary" id="btn-ask" type="button">重新搜题</button>
                    <button class="ghost" id="btn-copy" type="button" disabled>复制</button>
                    <button class="ghost" id="btn-fill" type="button" disabled>填入</button>
                </div>
                <details id="preview" hidden>
                    <summary>查看题目原文</summary>
                    <pre id="preview-pre"></pre>
                </details>
            </div>
            <form class="bd settings" id="settings" aria-labelledby="panel-title" novalidate hidden>
                <button class="ghost" id="btn-back" type="button" aria-controls="bd">返回答题</button>
                <div class="field">
                    <label for="base">API 地址</label>
                    <input type="text" inputmode="url" id="base" placeholder="https://api.example.com/v1" aria-describedby="base-tip" autocomplete="off" spellcheck="false">
                    <div class="tip" id="base-tip">填写服务商的 OpenAI 兼容 Base URL，例如 https://api.example.com/v1。</div>
                </div>
                <div class="field">
                    <label for="key">API Key</label>
                    <input type="password" id="key" autocomplete="off" spellcheck="false" aria-describedby="key-tip">
                    <div class="tip" id="key-tip"></div>
                    <label class="chk" id="clear-key-row" hidden><input type="checkbox" id="clear-key">清除已保存的 Key</label>
                </div>
                <div class="field model-field">
                    <label for="models">模型列表</label>
                    <div class="row">
                        <select id="models" disabled></select>
                        <button class="ghost" id="btn-models" type="button">获取列表</button>
                    </div>
                    <div class="st" id="model-status" role="status"></div>
                    <label for="model">模型 ID</label>
                    <input type="text" id="model" placeholder="从列表选取，或手动填写" autocomplete="off" spellcheck="false">
                </div>
                <button class="primary" id="btn-save" type="submit">保存设置</button>
                <div class="st" id="settings-status" role="status"></div>
            </form>
            <footer class="foot">
                <span>© 2026 DreamYuande</span>
                <a href="https://github.com/DreamYuande/ucampus-ai-helper" target="_blank" rel="noopener noreferrer">
                    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8 8 0 0 0 8 0Z"/></svg>
                    GitHub
                </a>
            </footer>
        </section>
        <button class="ball" id="ball" type="button" aria-label="展开答题助手" hidden>AI</button>
    `;

    // shadowRoot.getElementById 在部分环境不存在，统一用 querySelector
    function byId(root, id) {
        return (root.querySelector && root.querySelector('#' + id)) || null;
    }

    const hostEl = document.createElement('div');
    hostEl.id = 'ucampus-ai-helper-host';
    hostEl.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483646;';
    const shadow = hostEl.attachShadow({ mode: 'closed' });
    shadow.innerHTML = '<style>' + CSS + '</style>' + HTML;
    (document.body || document.documentElement).appendChild(hostEl);

    const ui = {
        panel: byId(shadow, 'panel'),
        bd: byId(shadow, 'bd'),
        ball: byId(shadow, 'ball'),
        hd: byId(shadow, 'hd'),
        title: byId(shadow, 'panel-title'),
        btnSettings: byId(shadow, 'btn-settings'),
        btnBack: byId(shadow, 'btn-back'),
        settings: byId(shadow, 'settings'),
        base: byId(shadow, 'base'),
        key: byId(shadow, 'key'),
        keyTip: byId(shadow, 'key-tip'),
        clearKey: byId(shadow, 'clear-key'),
        clearKeyRow: byId(shadow, 'clear-key-row'),
        models: byId(shadow, 'models'),
        model: byId(shadow, 'model'),
        btnModels: byId(shadow, 'btn-models'),
        modelStatus: byId(shadow, 'model-status'),
        settingsStatus: byId(shadow, 'settings-status'),
        ans: byId(shadow, 'ans'),
        st: byId(shadow, 'st'),
        preview: byId(shadow, 'preview'),
        previewPre: byId(shadow, 'preview-pre'),
        btnAsk: byId(shadow, 'btn-ask'),
        btnCopy: byId(shadow, 'btn-copy'),
        btnFill: byId(shadow, 'btn-fill'),
        activeModel: byId(shadow, 'active-model'),
        btnMin: byId(shadow, 'btn-min'),
    };

    /* ---------- 状态与展示 ---------- */
    let busy = false;
    let autoRunEpoch = 0;
    let lastQ = null;      // 最近一次识别到的题目
    let lastA = '';        // 最近一次拿到的答案

    function setStatus(msg, kind) {
        ui.st.textContent = msg || '';
        ui.st.className = 'st' + (kind ? ' ' + kind : '');
    }

    function setAnswer(text, empty) {
        ui.ans.textContent = text;
        ui.ans.classList.toggle('empty', !!empty);
        ui.btnCopy.disabled = !!empty;
    }

    const apiReady = (config) => !!config.model && (config.saved || !!config.key);

    function syncConfig(config = getApiConfig()) {
        const model = apiReady(config) ? '模型：' + config.model : '未配置 API';
        ui.activeModel.textContent = model;
        ui.activeModel.title = model;
    }

    function resetAnswer() {
        lastQ = null;
        lastA = '';
        lastAnswerUrl = '';
        ui.btnFill.disabled = true;
        showPreview(null);
        setAnswer('答案显示在这里', true);
    }

    function showPreview(q) {
        if (!q || !q.text) {
            ui.preview.hidden = true;
            ui.preview.open = false;
            ui.previewPre.textContent = '';
            return;
        }
        const typeName = {
            single: '单选题', multiple: '多选题', judge: '判断题',
            blank: '填空题', translate: '翻译/写作', rewrite: '句型改写', match: '拖拽配对',
        }[q.type] || q.type;
        const unit = { rewrite: ' 题', match: ' 组' }[q.type] || ' 空';
        ui.previewPre.textContent = '【识别题型】' + typeName +
            (q.blanks ? '（' + q.blanks + unit + '）' : '') + '\n\n' + q.text;
        ui.preview.hidden = false;
    }

    function setBusy(on) {
        busy = on;
        ui.btnAsk.disabled = on;
        ui.btnAsk.textContent = on ? '处理中…' : '重新搜题';
    }

    /* ---------- 浮窗位置 ---------- */
    (function enableDrag() {
        let drag = null;
        const pos = store.get(CFG.POS_STORE, null);
        if (Number.isFinite(pos?.right) && Number.isFinite(pos?.bottom)) {
            ui.panel.style.right = pos.right + 'px';
            ui.panel.style.bottom = pos.bottom + 'px';
        }

        ui.hd.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 || !e.isPrimary || e.target.closest('button')) return;
            const rect = ui.panel.getBoundingClientRect();
            drag = { id: e.pointerId, x: e.clientX, y: e.clientY, right: innerWidth - rect.right, bottom: innerHeight - rect.bottom, moved: false };
            ui.hd.setPointerCapture(e.pointerId);
        });
        ui.hd.addEventListener('pointermove', (e) => {
            if (!drag || drag.id !== e.pointerId) return;
            const dx = e.clientX - drag.x;
            const dy = e.clientY - drag.y;
            if (!drag.moved && Math.hypot(dx, dy) < 3) return;
            drag.moved = true;
            ui.panel.style.right = (drag.right - dx) + 'px';
            ui.panel.style.bottom = (drag.bottom - dy) + 'px';
            keepOnScreen();
        });
        ui.hd.addEventListener('lostpointercapture', (e) => {
            if (!drag || drag.id !== e.pointerId) return;
            if (drag.moved) {
                store.set(CFG.POS_STORE, {
                    right: parseFloat(ui.panel.style.right),
                    bottom: parseFloat(ui.panel.style.bottom),
                });
            }
            drag = null;
        });
    })();

    function keepOnScreen() {
        if (ui.panel.hidden) return;
        const rect = ui.panel.getBoundingClientRect();
        const clamp = (offset, room) => Math.max(8, Math.min(offset, room - 8));
        const right = innerWidth - rect.right;
        const bottom = innerHeight - rect.bottom;
        const nextRight = clamp(right, innerWidth - rect.width);
        const nextBottom = clamp(bottom, innerHeight - rect.height);
        if (right !== nextRight) ui.panel.style.right = nextRight + 'px';
        if (bottom !== nextBottom) ui.panel.style.bottom = nextBottom + 'px';
    }
    window.addEventListener('resize', keepOnScreen);
    if (typeof ResizeObserver === 'function') new ResizeObserver(keepOnScreen).observe(ui.panel);
    keepOnScreen();

    /* ---------- 收起 / 展开 ---------- */
    function minimize() {
        ui.panel.hidden = true;
        ui.ball.hidden = false;
        ui.ball.focus({ preventScroll: true });
    }

    function expand() {
        ui.panel.hidden = false;
        ui.ball.hidden = true;
        keepOnScreen();
        (ui.settings.hidden ? ui.btnSettings : ui.btnBack).focus({ preventScroll: true });
    }

    ui.btnMin.addEventListener('click', (e) => { e.stopPropagation(); minimize(); });
    ui.ball.addEventListener('click', expand);

    /* ---------- API 设置 ---------- */
    let formReady = false;
    let draftBase = '';
    let typedKeyBase = '';
    let modelIds = [];
    let listRequest = 0;
    let loadedFor = null;
    let pendingFor = null;
    const sameConnection = (a, b) => !!a && !!b && a.base === b.base && a.key === b.key;

    function fieldStatus(el, text, kind = '') {
        el.textContent = text;
        el.className = kind ? 'st ' + kind : 'st';
    }

    function validDraftBase() {
        try { return normalizeBase(ui.base.value); } catch (e) { return ''; }
    }

    function keyForBase(base) {
        const saved = getApiConfig();
        const typed = ui.key.value.trim();
        if (typed && typedKeyBase === base) return typed;
        return base === saved.base && !ui.clearKey.checked ? saved.key : '';
    }

    function updateKeyHint() {
        const saved = getApiConfig();
        const hasKey = !!saved.key && saved.base === validDraftBase();
        ui.clearKeyRow.hidden = !hasKey;
        if (!hasKey) ui.clearKey.checked = false;
        ui.keyTip.textContent = hasKey
            ? '留空会保留此地址已保存的 Key。'
            : '仅在服务商需要认证时填写。Key 只发给此 API 地址。';
    }

    function renderModels() {
        const options = [new Option(modelIds.length ? '选择模型' : '暂无模型', '')];
        modelIds.forEach((id) => options.push(new Option(id, id)));
        ui.models.replaceChildren(...options);
        ui.models.disabled = modelIds.length === 0;
        ui.models.value = modelIds.includes(ui.model.value.trim()) ? ui.model.value.trim() : '';
    }

    function resetModelList() {
        ++listRequest;
        loadedFor = null;
        pendingFor = null;
        modelIds = [];
        ui.btnModels.disabled = false;
        ui.btnModels.textContent = '获取列表';
        ui.models.removeAttribute('aria-busy');
        renderModels();
        fieldStatus(ui.modelStatus, '也可直接在下方填写模型 ID。');
        fieldStatus(ui.settingsStatus, '');
    }

    async function refreshModels(force = false) {
        let base;
        try { base = normalizeBase(ui.base.value); }
        catch (e) {
            if (force) {
                fieldStatus(ui.modelStatus, e.message, 'err');
                ui.base.focus();
            }
            return;
        }
        const config = { base, key: keyForBase(base) };
        if (sameConnection(config, pendingFor) || (!force && sameConnection(config, loadedFor))) return;

        const requestId = ++listRequest;
        pendingFor = config;
        ui.btnModels.disabled = true;
        ui.btnModels.textContent = '获取中…';
        ui.models.setAttribute('aria-busy', 'true');
        fieldStatus(ui.modelStatus, '正在读取 /models…');
        try {
            const ids = await fetchModels(config);
            if (requestId !== listRequest) return;
            loadedFor = config;
            modelIds = ids;
            renderModels();
            fieldStatus(ui.modelStatus, ids.length ? '已获取 ' + ids.length + ' 个模型' : '列表为空，请手动输入模型 ID。', ids.length ? 'ok' : 'warn');
        } catch (e) {
            if (requestId !== listRequest) return;
            fieldStatus(ui.modelStatus, e.message, 'err');
        } finally {
            if (requestId === listRequest) {
                pendingFor = null;
                ui.btnModels.disabled = false;
                ui.btnModels.textContent = '获取列表';
                ui.models.removeAttribute('aria-busy');
            }
        }
    }

    function showSettings() {
        const config = getApiConfig();
        if (!formReady) {
            formReady = true;
            ui.base.value = config.base;
            ui.model.value = config.model;
            draftBase = config.base;
            resetModelList();
        }
        autoRunEpoch++;
        ui.bd.hidden = true;
        ui.settings.hidden = false;
        ui.btnSettings.hidden = true;
        updateAutoWatch();
        ui.title.textContent = 'API 设置';
        updateKeyHint();
        ui.title.focus({ preventScroll: true });
        keepOnScreen();
        if ((config.saved || config.key) && validDraftBase() === config.base && keyForBase(config.base) === config.key) {
            void refreshModels();
        }
    }

    function showHome() {
        ui.settings.hidden = true;
        ui.bd.hidden = false;
        ui.btnSettings.hidden = false;
        ui.title.textContent = 'U校园 AI 答题助手';
        syncConfig();
        ui.btnSettings.focus({ preventScroll: true });
        keepOnScreen();
        updateAutoWatch();
    }

    ui.btnSettings.addEventListener('click', showSettings);
    ui.btnBack.addEventListener('click', showHome);
    ui.base.addEventListener('input', () => { resetModelList(); updateKeyHint(); });
    ui.base.addEventListener('change', () => {
        const base = validDraftBase();
        if (base && base !== draftBase) {
            if (ui.key.value && typedKeyBase !== base) ui.key.value = '';
            ui.model.value = '';
            draftBase = base;
        }
    });
    ui.key.addEventListener('input', () => {
        typedKeyBase = validDraftBase();
        ui.clearKey.checked = false;
        resetModelList();
    });
    ui.key.addEventListener('change', () => {
        if (ui.key.value.trim() && typedKeyBase === validDraftBase()) void refreshModels();
    });
    ui.clearKey.addEventListener('change', () => {
        if (ui.clearKey.checked) ui.key.value = '';
        resetModelList();
    });
    ui.btnModels.addEventListener('click', () => void refreshModels(true));
    ui.models.addEventListener('change', () => {
        if (ui.models.value) ui.model.value = ui.models.value;
        fieldStatus(ui.settingsStatus, '');
    });
    ui.model.addEventListener('input', () => {
        ui.models.value = modelIds.includes(ui.model.value.trim()) ? ui.model.value.trim() : '';
        fieldStatus(ui.settingsStatus, '');
    });

    ui.settings.addEventListener('submit', (e) => {
        e.preventDefault();
        let base;
        try { base = normalizeBase(ui.base.value); }
        catch (err) {
            fieldStatus(ui.settingsStatus, err.message, 'err');
            ui.base.focus();
            return;
        }
        const config = { base, key: keyForBase(base), model: ui.model.value.trim() };
        try {
            if (typeof GM_setValue !== 'function') throw new Error('storage');
            GM_setValue(CFG.API_STORE, config);
        } catch (err) {
            fieldStatus(ui.settingsStatus, '保存失败，请检查 Tampermonkey 是否启用。', 'err');
            return;
        }
        ui.base.value = base;
        ui.model.value = config.model;
        ui.key.value = '';
        ui.clearKey.checked = false;
        draftBase = base;
        updateKeyHint();
        if (config.model) {
            autoAttempts.clear();
            resetAnswer();
            showReadyStatus();
            showHome();
        } else {
            fieldStatus(ui.settingsStatus, '请选择或填写模型 ID 后再保存。', 'warn');
            ui.model.focus();
        }
    });

    /* ---------- 复制 ---------- */
    async function copyAnswer() {
        const text = ui.ans.textContent || '';
        if (!text || ui.ans.classList.contains('empty')) {
            setStatus('还没有可复制的答案', 'warn');
            return;
        }
        try {
            await navigator.clipboard.writeText(text);
            setStatus('已复制到剪贴板', 'ok');
            return;
        } catch (e) { /* 继续走兜底 */ }

        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
            document.body.appendChild(ta);
            ta.select();
            let copied;
            try { copied = document.execCommand('copy'); }
            finally { ta.remove(); }
            if (!copied) throw new Error('copy');
            setStatus('已复制到剪贴板', 'ok');
        } catch (e) {
            setStatus('复制失败，请手动选中文字复制', 'err');
        }
    }

    ui.btnCopy.addEventListener('click', copyAnswer);

    /* ---------- 自动填入 ---------- */
    function fillMessage(r) {
        if (!r) return '答案已返回，但填入超时，请手动选择';
        if (!r.total) return '答案已返回；这道题没找到可填控件，请手动作答';
        if (!r.filled) return '答案已返回，但没能填入（' + (r.note || '控件结构不匹配') + '）';
        return '已填入或匹配 ' + r.filled + ' / ' + r.total + ' 处。' + (r.note || '请核对后手动提交');
    }

    let filling = false;
    let lastAnswerUrl = '';

    async function doFill() {
        if (busy || filling || ui.btnFill.disabled) return;
        if (!lastQ || !lastA) {
            setStatus('请先获取答案', 'warn');
            return;
        }
        if (lastAnswerUrl !== location.href) {
            setStatus('已切换页面，请重新获取当前题目的答案', 'warn');
            return;
        }
        filling = true;
        const requestUrl = lastAnswerUrl;
        ui.btnFill.disabled = true;
        setStatus('正在填入…');
        try {
            const r = await applyAnswer(lastQ, lastA, () => requestUrl === location.href);
            if (requestUrl === location.href) setStatus(fillMessage(r), r && r.filled > 0 && !r.note ? 'ok' : 'warn');
        } catch (e) {
            if (requestUrl === location.href) setStatus('填入失败：' + ((e && e.message) || e), 'err');
        } finally {
            filling = false;
            ui.btnFill.disabled = !lastA || lastAnswerUrl !== location.href;
            scheduleAuto();
        }
    }

    ui.btnFill.addEventListener('click', doFill);

    /* ---------- 主流程 ---------- */
    async function onAsk(automaticQuestion = null) {
        if (busy || filling) return;
        const automatic = !!automaticQuestion;
        const epoch = autoRunEpoch;
        const requestUrl = location.href;
        const config = getApiConfig();
        if (!apiReady(config)) {
            if (automatic) return;
            showSettings();
            fieldStatus(ui.settingsStatus, '请填写 API 设置并保存，再返回答题。', 'warn');
            (config.model ? ui.key : ui.model).focus();
            return;
        }

        setBusy(true);
        resetAnswer();
        setAnswer('正在读取题目…', true);
        setStatus('正在提取题目…');

        let requestedKey = '';
        try {
            const q = automaticQuestion || await extractQuestion();
            if (!q || !q.text || q.text.length < 8) {
                setStatus('没识别到题目，请把题目滚动到屏幕中间再试一次', 'warn');
                showPreview(null);
                setAnswer('未识别到题目', true);
                return;
            }

            const currentConfig = () => {
                const active = getApiConfig();
                return epoch === autoRunEpoch && location.href === requestUrl && ui.settings.hidden &&
                    active.base === config.base && active.key === config.key && active.model === config.model;
            };
            if (!currentConfig()) return;
            const questionKey = autoQuestionKey(q);
            if (automatic && (!canRunAutomatically() || autoAttempts.has(questionKey))) return;
            autoAttempts.add(questionKey);
            requestedKey = questionKey;
            showPreview(q);
            setStatus('正在请求 ' + config.model + '…');
            setAnswer('等待模型返回答案…', true);

            const answer = await getAnswer(q, config, !automatic);
            if (!currentConfig()) return;
            const fresh = await extractQuestion(automatic);
            if (!currentConfig()) return;
            if (!sameQuestion(q, fresh)) {
                setAnswer('题目有变化，正在重新识别。', true);
                setStatus('等待识别当前题目…');
                return;
            }
            if (!answer || /^信息不足[。.]?$/.test(answer)) {
                setAnswer(answer ? '题目信息不足，请核对题目原文。' : '模型未返回答案。', true);
                setStatus('核对题目后，可点击「重新搜题」。', 'warn');
                return;
            }

            setAnswer(answer, false);
            lastQ = fresh;
            lastA = answer;
            lastAnswerUrl = requestUrl;
            ui.btnFill.disabled = false;

            const canContinue = () => currentConfig() && document.visibilityState === 'visible';
            if (canContinue() && (fresh._frame ? fresh.untouched : isUntouched(fresh))) {
                setStatus('答案已返回，正在填入…');
                let r = null;
                try { r = await applyAnswer(fresh, answer, canContinue, true); } catch (e) { r = null; }
                if (currentConfig()) setStatus(fillMessage(r), r?.filled > 0 && !r.note ? 'ok' : 'warn');
            } else {
                setStatus('答案已就绪，原作答未改动。', 'ok');
            }
        } catch (err) {
            if (epoch === autoRunEpoch && location.href === requestUrl && ui.settings.hidden) {
                const msg = (err && err.message) ? err.message : String(err);
                setAnswer(msg, true);
                setStatus('请求失败，可点击「重新搜题」。', 'err');
            }
        } finally {
            if (requestedKey && epoch !== autoRunEpoch && location.href === requestUrl) autoAttempts.delete(requestedKey);
            setBusy(false);
            scheduleAuto();
        }
    }

    ui.btnAsk.addEventListener('click', () => void onAsk());

    /* ---------- 页面自动取题 ---------- */
    const autoAttempts = new Set();
    let autoTimer = null;
    let autoCandidate = null;
    let autoScanning = false;
    let retryUntil = 0;

    function isCoursePage() {
        return /\/courseware(?:\/|$)/.test(location.pathname + location.hash) ||
            (location.hostname === 'ucontent.unipus.cn' && /\/(?:pc|index)\.html$/.test(location.pathname));
    }

    function canRunAutomatically() {
        return ui.settings.hidden && document.visibilityState === 'visible' && isCoursePage() && apiReady(getApiConfig());
    }

    function autoQuestionKey(q) {
        return JSON.stringify([location.href, q._frame?.getAttribute('src') || '', q.type, q.identity || questionIdentity(q)]);
    }

    function scheduleAuto() {
        if (autoTimer !== null || autoScanning || busy || filling || !canRunAutomatically()) return;
        autoTimer = setTimeout(scanAuto, 420);
    }

    async function scanAuto() {
        autoTimer = null;
        if (busy || filling || !canRunAutomatically()) return;
        const epoch = autoRunEpoch;
        const url = location.href;
        let chosen = null;
        let retry = false;
        autoScanning = true;
        try {
            const q = await extractQuestion(true);
            if (epoch !== autoRunEpoch || url !== location.href || !canRunAutomatically() || busy || filling) return;
            if (!q) {
                autoCandidate = null;
                retry = Date.now() < retryUntil;
                if (!retry && !lastA) setStatus('暂未识别到题目，可点击「重新搜题」。', 'warn');
                return;
            }
            const key = autoQuestionKey(q);
            if (autoAttempts.has(key)) return;
            if (!autoCandidate || autoCandidate.key !== key || !sameQuestion(q, autoCandidate.q)) {
                autoCandidate = { key, q };
                retry = true;
                return;
            }
            autoCandidate = null;
            chosen = q;
        } catch (e) {
            retry = Date.now() < retryUntil;
        } finally {
            autoScanning = false;
            if (chosen) void onAsk(chosen);
            else if (retry || epoch !== autoRunEpoch || url !== location.href) scheduleAuto();
        }
    }

    const autoObserver = new MutationObserver(() => {
        if (!coursePageChanged()) scheduleAuto();
    });

    function updateAutoWatch() {
        clearTimeout(autoTimer);
        autoTimer = null;
        autoCandidate = null;
        autoObserver.disconnect();
        if (!canRunAutomatically()) return;
        retryUntil = Date.now() + 9000;
        autoObserver.observe(document.body, {
            subtree: true, childList: true, characterData: true, attributes: true,
            attributeFilter: ['class', 'style', 'src', 'hidden', 'aria-hidden', 'disabled', 'readonly', 'draggable'],
        });
        scheduleAuto();
    }

    function showReadyStatus(config = getApiConfig()) {
        if (!apiReady(config)) {
            setStatus('请先在 API 设置中保存地址和模型。', 'warn');
        } else if (isCoursePage()) {
            setStatus('等待识别题目…');
        } else {
            setStatus('等待进入课程题目页');
        }
    }

    let currentPage = location.href;
    function coursePageChanged() {
        if (currentPage === location.href) return false;
        currentPage = location.href;
        autoRunEpoch++;
        resetAnswer();
        showReadyStatus();
        updateAutoWatch();
        return true;
    }
    window.addEventListener('hashchange', coursePageChanged);
    window.addEventListener('popstate', coursePageChanged);
    document.addEventListener('visibilitychange', () => { if (!coursePageChanged()) updateAutoWatch(); });
    window.addEventListener('scroll', scheduleAuto, { capture: true, passive: true });
    document.addEventListener('load', (e) => {
        if (e.target.matches?.('iframe,frame')) scheduleAuto();
    }, true);
    updateAutoWatch();

    syncConfig();
    showReadyStatus();
})();
