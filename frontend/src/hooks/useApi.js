import axios from 'axios'
import { useState, useEffect, useCallback } from 'react'

const client = axios.create({ baseURL: '/api/v1' })

/**
 * GET /api/v1/<path>
 * Returns { data, loading, error, refetch }
 */
export function useGet(path) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const fetch = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await client.get(path)
      setData(res.data)
    } catch (err) {
      setError(err?.response?.data?.detail ?? err.message)
    } finally {
      setLoading(false)
    }
  }, [path])

  useEffect(() => { fetch() }, [fetch])

  return { data, loading, error, refetch: fetch }
}

/**
 * Returns a post(path, body?) function plus { loading, error, data }.
 */
export function usePost(path) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const post = useCallback(async (body = {}) => {
    setLoading(true)
    setError(null)
    try {
      const res = await client.post(path, body)
      setData(res.data)
      return res.data
    } catch (err) {
      const msg = err?.response?.data?.detail ?? err.message
      setError(msg)
      throw new Error(msg)
    } finally {
      setLoading(false)
    }
  }, [path])

  return { post, data, loading, error }
}

export default client
