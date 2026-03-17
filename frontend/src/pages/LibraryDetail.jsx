import { useParams } from 'react-router-dom'

export default function LibraryDetail() {
  const { id } = useParams()
  return (
    <div>
      <h2 className="text-xl font-semibold mb-1">Library</h2>
      <p className="text-zinc-400 text-sm">Showing details for library <code>{id}</code>.</p>
    </div>
  )
}
