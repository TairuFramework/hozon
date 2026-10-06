import { createRoot } from 'react-dom/client'

import App from './App'

const root = document.getElementById('root')
if (root == null) throw new Error('Missing #root element')
createRoot(root).render(<App />)
