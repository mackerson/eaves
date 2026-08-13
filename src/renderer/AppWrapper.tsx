import { ThemeProvider } from './contexts/ThemeContext';
import { IconProvider } from './contexts/IconContext';
import App from './App';

// Import theme CSS globally
import './styles/theme.css';
import './styles/fonts.css';

export function AppWrapper() {
  return (
    <ThemeProvider defaultTheme="dark">
      <IconProvider>
        <App />
      </IconProvider>
    </ThemeProvider>
  );
}

export default AppWrapper;
