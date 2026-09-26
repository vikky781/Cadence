import { BrowserRouter, Route, Routes } from 'react-router-dom'

import ExperimentEditor from './builder/ExperimentEditor'
import ResultsPage from './results/ResultsPage'
import RunExperiment from './routes/RunExperiment'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ExperimentEditor />} />
        <Route path="/run" element={<RunExperiment />} />
        <Route path="/results" element={<ResultsPage />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
