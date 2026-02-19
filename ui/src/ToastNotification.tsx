import { useEffect } from 'react';
import { createDockerDesktopClient } from '@docker/extension-api-client';
import { Slide, ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import './ToastNotification.css';

const ddClient = createDockerDesktopClient();

const ToastNotification = () => {
    const NOTIFICATION_DELAY_MS = 5000; 
    const TWO_WEEKS_MS = 2 * 7 * 24 * 60 * 60 * 1000;
    const FIRST_LAUNCH_KEY = 'firstLaunchTimeStamp';
    const DONT_SHOW_AGAIN_KEY = 'dontShowSUSEAIAdvertisement';
    const SUSE_AI_URL = 'https://www.suse.com/products/ai/';
    const isDarkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;

    const handleDontShowAgain = (toastId: string | number) => {
        localStorage.setItem(DONT_SHOW_AGAIN_KEY, 'true');
        toast.dismiss(toastId);
    };

    const handleLinkClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        ddClient.host.openExternal(SUSE_AI_URL);
    };

    const shouldShowNotification = () => {
        const dontShowAgain = !!localStorage.getItem(DONT_SHOW_AGAIN_KEY);
        const firstLaunchTimeStamp = localStorage.getItem(FIRST_LAUNCH_KEY);
        const currentTime = Date.now();

        if (dontShowAgain) return false;

        if (!firstLaunchTimeStamp) {
            localStorage.setItem(FIRST_LAUNCH_KEY, currentTime.toString());
            return false;
        }

        return currentTime - parseInt(firstLaunchTimeStamp, 10) > TWO_WEEKS_MS;
    };

    const showNotification = async () => {
        if (!shouldShowNotification()) return;

        // Wait for few sec till OI page shows up
        await new Promise((resolve) => setTimeout(resolve, NOTIFICATION_DELAY_MS));

        const toastId = toast(
            <div>
                <p>
                    Enjoying the Rancher Desktop Open WebUI extension? Ready to deploy
                    Ollama and Open WebUI stack to production? Try out{' '}
                    <a
                        href="#"
                        onClick={handleLinkClick}
                        className="suse-link"
                    >
                        SUSE AI
                    </a>
                    !
                </p>
                <button 
                    onClick={() => handleDontShowAgain(toastId)}
                >
                    Don't show again
                </button>
            </div>
        );
    };

    useEffect(() => {
        showNotification();
    }, []);

    return (
        <ToastContainer
            position="top-right"
            theme={isDarkMode ? "dark" : "light"}
            hideProgressBar
            newestOnTop
            closeOnClick={false}
            autoClose={15000}
            rtl={false}
            pauseOnFocusLoss
            draggable
            pauseOnHover
            transition={Slide}
            style={{ zIndex: 1000 }}
        />
    );
};

export default ToastNotification;
