import { useEffect, useState } from 'react';
import LoadingView from './LoadingView';
import './WebpageFrame.css';

export default function WebpageFrame({ src, title }: { src: string; title: string }) {
  const [hideIframeView, setHideIframeView] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setHideIframeView(false), 1000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="rdx-iframe">
      {hideIframeView && (
        <div className="rdx-iframe__overlay" aria-hidden="true">
          <LoadingView />
        </div>
      )}
      <iframe
        src={src}
        title={title}
        allow="clipboard-read; clipboard-write"
        style={{ opacity: hideIframeView ? 0 : 1 }}
      />
    </div>
  );
}
