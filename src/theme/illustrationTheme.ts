import { theme } from 'antd';
import type { ConfigProviderProps } from 'antd';

const illustrationTheme: ConfigProviderProps = {
  theme: {
    algorithm: theme.defaultAlgorithm,
    token: {
      colorText: '#2C2C2C',
      colorPrimary: '#52C41A',
      colorSuccess: '#51CF66',
      colorWarning: '#FFD93D',
      colorError: '#FA5252',
      colorInfo: '#4DABF7',
      colorBorder: '#2C2C2C',
      colorBorderSecondary: '#2C2C2C',
      lineWidth: 3,
      lineWidthBold: 3,
      borderRadius: 12,
      borderRadiusLG: 16,
      borderRadiusSM: 8,
      controlHeight: 40,
      controlHeightSM: 34,
      controlHeightLG: 48,
      fontFamily: '"Sora", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      fontFamilyCode: '"SF Mono", "Fira Code", monospace',
      fontSize: 15,
      fontWeightStrong: 600,
      colorBgBase: '#FFF9F0',
      colorBgContainer: '#FFFFFF',
    },
    components: {
      Button: {
        primaryShadow: 'none',
        dangerShadow: 'none',
        defaultShadow: 'none',
        fontWeight: 600,
      },
      Modal: {
        boxShadow: 'none',
      },
      Card: {
        boxShadow: '4px 4px 0 #2C2C2C',
        colorBgContainer: '#FFF0F6',
      },
      Tooltip: {
        colorBorder: '#2C2C2C',
        colorBgSpotlight: 'rgba(100, 100, 100, 0.95)',
        borderRadius: 8,
      },
      Select: {
        optionSelectedBg: 'transparent',
      },
    },
  },
};

export default illustrationTheme;
