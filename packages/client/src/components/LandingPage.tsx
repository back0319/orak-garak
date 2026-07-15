import { useState, useEffect } from 'react';
import 'nes.css/css/nes.min.css';
import '../assets/fonts/Font.css';
import './LandingPage.css';
import { useGameStore } from '../store/gameStore';
import { useSFXContext } from '../contexts/SFXContext';

const MAX_NICKNAME_LENGTH = 8;
const TOOLTIP_DURATION = 2000;

interface LandingPageProps {
  onStart: (nickname: string) => void;
}

function LandingPage({ onStart }: LandingPageProps) {
  const [nickname, setNickname] = useState('');
  const [showTooltip, setShowTooltip] = useState(false);
  const [showLengthTooltip, setShowLengthTooltip] = useState(false);
  const { playSFX } = useSFXContext();

  const connectionError = useGameStore((s) => s.connectionError);
  const setConnectionError = useGameStore((s) => s.setConnectionError);

  // 접속 에러 메시지 자동 숨김 (2초 후)
  useEffect(() => {
    if (connectionError) {
      const timer = setTimeout(() => {
        setConnectionError(null);
      }, TOOLTIP_DURATION);
      return () => clearTimeout(timer);
    }
  }, [connectionError, setConnectionError]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (nickname.trim()) {
      onStart(nickname.trim());
    }
  };

  const handleNicknameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (value.length > MAX_NICKNAME_LENGTH) {
      setShowLengthTooltip(true);
      setTimeout(() => setShowLengthTooltip(false), TOOLTIP_DURATION);
      return;
    }
    setNickname(value);
  };

  return (
    <div className="landing-container">
      <a
        className="github-link"
        href="https://github.com/back0319/orak-garak"
        target="_blank"
        rel="noreferrer"
        aria-label="Orak Garak GitHub 저장소 새 탭에서 열기"
      >
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          aria-hidden="true"
          fill="currentColor"
        >
          <path d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.11.79-.25.79-.56v-2.23c-3.22.7-3.9-1.36-3.9-1.36-.52-1.34-1.28-1.69-1.28-1.69-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.57-.29-5.28-1.29-5.28-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.47.11-3.05 0 0 .97-.31 3.16 1.18a10.9 10.9 0 0 1 5.76 0c2.19-1.49 3.15-1.18 3.15-1.18.63 1.58.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.09 0 4.41-2.71 5.39-5.29 5.68.42.36.78 1.06.78 2.14v3.17c0 .31.21.68.8.56A11.5 11.5 0 0 0 12 .7Z" />
        </svg>
        <span>GitHub</span>
      </a>
      <div className="landing-content">
        <h1 className="nes-text is-primary game-title">다같이 오락가락</h1>

        <form onSubmit={handleSubmit} className="landing-form">
          <div className="nes-field">
            <label htmlFor="nickname">닉네임</label>
            <div style={{ position: 'relative' }}>
              <input
                type="text"
                id="nickname"
                className="nes-input"
                placeholder="닉네임을 입력하세요"
                value={nickname}
                onChange={handleNicknameChange}
                maxLength={MAX_NICKNAME_LENGTH}
                required
              />
              {showLengthTooltip && (
                <div className="length-tooltip">
                  닉네임은 최대 8자까지 입력 가능합니다
                </div>
              )}
            </div>
          </div>

          <div
            className="button-wrapper"
            onMouseEnter={() => {
              playSFX('buttonHover');
              if (!nickname.trim()) setShowTooltip(true);
            }}
            onMouseLeave={() => setShowTooltip(false)}
          >
            <button
              type="submit"
              className="nes-btn is-primary start-button"
              disabled={!nickname.trim()}
              onClick={() => playSFX('buttonClick')}
            >
              시작
            </button>
            {showTooltip && !nickname.trim() && (
              <div className="tooltip">닉네임을 입력하세요</div>
            )}
            {connectionError && (
              <div
                className="length-tooltip"
                style={{
                  bottom: '100%',
                  top: 'auto',
                  marginBottom: '10px',
                  marginTop: 0,
                }}
              >
                {connectionError.message}
              </div>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

export default LandingPage;
