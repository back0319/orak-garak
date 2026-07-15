import { useEffect, useRef, useState, type FormEvent } from 'react';
import { SystemPacketType } from '../../../common/src/packets';
import { socketManager } from '../network/socket';
import { useGameStore } from '../store/gameStore';

const MAX_MESSAGE_LENGTH = 100;
const CHAT_TIME_FORMATTER = new Intl.DateTimeFormat('ko-KR', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function formatTime(timestamp: number): string {
  return CHAT_TIME_FORMATTER.format(timestamp);
}

export default function LobbyChat() {
  const [draft, setDraft] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const messages = useGameStore((state) => state.lobbyChatMessages);
  const chatError = useGameStore((state) => state.lobbyChatError);
  const setChatError = useGameStore((state) => state.setLobbyChatError);
  const players = useGameStore((state) => state.players);
  const myselfIndex = useGameStore((state) => state.myselfIndex);
  const myPlayerId = players[myselfIndex]?.id;
  const messageListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const messageList = messageListRef.current;
    if (messageList) messageList.scrollTop = messageList.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (!chatError) return;
    const timer = window.setTimeout(() => setChatError(null), 3_000);
    return () => window.clearTimeout(timer);
  }, [chatError, setChatError]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message) return;

    socketManager.send({
      type: SystemPacketType.LOBBY_CHAT_SEND,
      message,
    });
    setDraft('');
  };

  return (
    <>
      <button
        type="button"
        className="nes-btn is-primary lobby-chat-toggle"
        aria-expanded={isOpen}
        aria-controls="lobby-chat-panel"
        onClick={() => setIsOpen((open) => !open)}
      >
        채팅
      </button>

      <section
        id="lobby-chat-panel"
        className={`nes-container is-rounded lobby-chat-panel ${
          isOpen ? 'is-open' : ''
        }`}
        aria-label="로비 채팅"
      >
        <div className="lobby-chat-header">
          <h2 className="section-title">채팅</h2>
          <button
            type="button"
            className="nes-btn lobby-chat-close"
            aria-label="채팅 닫기"
            onClick={() => setIsOpen(false)}
          >
            닫기
          </button>
        </div>

        <div
          ref={messageListRef}
          className="lobby-chat-messages"
          role="log"
          aria-live="polite"
          aria-relevant="additions"
        >
          {messages.length === 0 ? (
            <p className="lobby-chat-empty">아직 메시지가 없어요.</p>
          ) : (
            messages.map((message) => (
              <article
                key={message.id}
                className={`lobby-chat-message ${
                  message.playerId === myPlayerId ? 'is-mine' : ''
                }`}
              >
                <div className="lobby-chat-message-meta">
                  <strong style={{ color: message.playerColor }}>
                    {message.playerName}
                  </strong>
                  <time dateTime={new Date(message.sentAt).toISOString()}>
                    {formatTime(message.sentAt)}
                  </time>
                </div>
                <p>{message.message}</p>
              </article>
            ))
          )}
        </div>

        {chatError && <p className="lobby-chat-error">{chatError}</p>}

        <form className="lobby-chat-form" onSubmit={handleSubmit}>
          <input
            className="nes-input"
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={MAX_MESSAGE_LENGTH}
            placeholder="메시지 입력"
            aria-label="채팅 메시지"
            autoComplete="off"
          />
          <button
            type="submit"
            className="nes-btn is-primary"
            disabled={!draft.trim()}
          >
            전송
          </button>
        </form>
        <span className="lobby-chat-count" aria-hidden="true">
          {Array.from(draft).length}/{MAX_MESSAGE_LENGTH}
        </span>
      </section>
    </>
  );
}
