import { describe, expect, test } from 'bun:test';
import { createChatScrollFollower } from './useChatScroll';

function viewport() {
  return { scrollTop: 0, scrollHeight: 1000, clientHeight: 300 };
}

describe('chat scroll following without a DOM', () => {
  test('follows delayed content growth after the final text update', () => {
    const box = viewport();
    const chat = createChatScrollFollower(box);
    chat.refresh();
    expect(box.scrollTop).toBe(700);
    box.scrollHeight = 1450;
    chat.refresh();
    expect(box.scrollTop).toBe(1150);
  });

  test('keeps the reading position until the person returns to the bottom', () => {
    const box = viewport();
    const chat = createChatScrollFollower(box);
    chat.refresh();
    box.scrollTop = 400;
    chat.onScroll();
    box.scrollHeight = 1200;
    chat.refresh();
    expect(box.scrollTop).toBe(400);
    box.scrollTop = 900;
    chat.onScroll();
    box.scrollHeight = 1300;
    chat.refresh();
    expect(box.scrollTop).toBe(1000);
  });

  test('content anchoring toward the new bottom does not cancel following', () => {
    const box = viewport();
    const chat = createChatScrollFollower(box);
    chat.refresh();
    box.scrollHeight = 1200;
    box.scrollTop = 800;
    chat.onScroll();
    chat.refresh();
    expect(box.scrollTop).toBe(900);
  });

  test('viewport shrink follows only while the person has not scrolled away', () => {
    const box = viewport();
    const chat = createChatScrollFollower(box);
    chat.refresh();
    box.clientHeight = 200;
    chat.refresh();
    expect(box.scrollTop).toBe(800);
    box.scrollTop = 500;
    chat.onScroll();
    box.clientHeight = 100;
    chat.refresh();
    expect(box.scrollTop).toBe(500);
  });

  test('an explicit history jump stays paused through near-edge smooth-scroll frames', () => {
    const box = viewport();
    const chat = createChatScrollFollower(box);
    chat.refresh();
    chat.pause();
    box.scrollTop = 690;
    chat.onScroll();
    box.scrollHeight = 1100;
    chat.refresh();
    expect(box.scrollTop).toBe(690);
    box.scrollTop = 400;
    chat.onScroll();
    box.scrollHeight = 1200;
    chat.refresh();
    expect(box.scrollTop).toBe(400);
    box.scrollTop = 900;
    chat.onScroll();
    box.scrollHeight = 1300;
    chat.refresh();
    expect(box.scrollTop).toBe(1000);
  });

  test('a grouped review follows the newest QA instead of later file groups', () => {
    const box = { scrollTop: 0, scrollHeight: 2200, clientHeight: 300 };
    let newestAnswerTop = 500;
    const chat = createChatScrollFollower(box, () => newestAnswerTop);
    chat.refresh();
    expect(box.scrollTop).toBe(500);
    newestAnswerTop = 650;
    chat.refresh();
    expect(box.scrollTop).toBe(650);
    box.scrollTop = 900;
    chat.onScroll();
    newestAnswerTop = 750;
    chat.refresh();
    expect(box.scrollTop).toBe(900);
    box.scrollTop = 750;
    chat.onScroll();
    newestAnswerTop = 850;
    chat.refresh();
    expect(box.scrollTop).toBe(850);
  });

  test('a collapsed or absent review target does not jump to unrelated content', () => {
    const box = viewport();
    let target: number | null = null;
    const chat = createChatScrollFollower(box, () => target);
    chat.refresh();
    expect(box.scrollTop).toBe(0);
    target = 400;
    chat.refresh();
    expect(box.scrollTop).toBe(400);
  });

  test('the existing 24px edge separates following from reading earlier content', () => {
    for (const distance of [23, 24]) {
      const box = viewport();
      const chat = createChatScrollFollower(box);
      chat.refresh();
      box.scrollTop -= distance;
      chat.onScroll();
      box.scrollHeight = 1200;
      chat.refresh();
      expect(box.scrollTop).toBe(distance === 23 ? 900 : 676);
    }
  });
});
